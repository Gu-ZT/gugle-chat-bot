import fs from 'node:fs';
import path from 'node:path';
import { Message as DiscordMessage } from 'discord.js';
import { QQBot } from '@/index';
import { ForwardMessage, GroupMessageWSMSG, Message, PrivateMessageWSMSG, ReceiveMessage } from '@/type';
import { getHermesConfig, isHermesAdmin } from '@/features/hermes/config';
import { HermesClient } from '@/features/hermes/client';
import { SkillManager } from '@/features/hermes/skills';
import { ChatHistoryStore } from '@/features/hermes/history';
import { renderApprovalImage, renderProgressImage } from '@/features/hermes/render';
import {
  decideGroupTrigger,
  isResetCommand,
  isStopCommand,
  parseApprovalChoice,
  splitMessageText
} from '@/features/hermes/trigger';
import {
  Approval,
  ApprovalChoice,
  DiscordChatParams,
  FormattedMessage,
  GroupAdminApi,
  HermesApprovalEvent,
  MessageContentPart,
  OneBotForwardNode,
  OneBotGetForwardMsgResponse,
  OneBotGetMsgResponse,
  OneBotGroupMemberInfo,
  RouteInfo,
  RunState,
  Session
} from '@/features/hermes/types';

/**
 * QQ ⇄ Hermes Agent 桥接（移植自 qq-hermes-bridge src/index.ts，MIT 协议，原作者 Amorter：
 * https://github.com/Amorter/qq-hermes-bridge）。
 *
 * 与上游的差异：
 * - OneBot 连接/事件/发送全部复用本仓库 QQBot（不再自建 WebSocket 客户端）；
 * - 配置改为 configs/features/hermes.json（ConfigStore 热重载），SOUL.md 读 configs/SOUL.md；
 * - 管理员 = hermes admins ∪ management operators；
 * - 群聊命令守卫：/ 或 ! 开头的消息不触发（除非显式 @bot），避免与 gugle-command 双重响应；
 * - 审批否定词（不允许/不批准）匹配顺序修正（上游先匹配「批准」导致否定词不可达）；
 * - 不实现 COMPACT_LINES 合并转发（上游默认关闭），长回复按长度切分发送；
 * - AI 的群回复经 bot.sendGroupMsg 发出，会按既定行为同步转发到互通的 Discord 频道。
 *
 * Discord 频道触发（对上游的扩展）：
 * - 互通的 Discord 频道消息同样可触发 AI（@提及/关键词/requireMention 同一套规则），
 *   频道是否启用由其桥接的 QQ 群是否在 hermes.json groups 中决定；
 * - Discord 与 QQ 群共享同一份会话上下文（group:{群号}），AI 能看到两侧的对话；
 * - AI 回复发在提问侧（Discord 提问回 Discord，QQ 提问回 QQ），发送经 DiscordBridge
 *   注入的委托完成，本模块不持有 discord.js Client；
 * - Discord 侧管理员（服务器拥有者/管理服务器/管理员权限）可审批与调用管理技能；
 *   QQ 用户黑白名单（allowedUsers/blockedUsers）不约束 Discord 用户。
 */

/** 图片扩展名 → MIME 类型映射（本地图片转 base64 data URL 用） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
};

/** 从路径/URL 扩展名推断 MIME，未知默认 image/jpeg */
function mimeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.split(/[?#]/)[0]?.toLowerCase() || '';
  return IMAGE_MIME_BY_EXT[ext] || 'image/jpeg';
}

export class HermesBridge {
  private static instance?: HermesBridge;

  public static getInstance(): HermesBridge {
    if (!HermesBridge.instance) HermesBridge.instance = new HermesBridge();
    return HermesBridge.instance;
  }

  private bot?: QQBot;
  private readonly hermes = new HermesClient();
  private readonly skillManager = new SkillManager();

  /** 对话会话：sessionKey → Session */
  private readonly sessions = new Map<string, Session>();
  /** 活跃运行：runId → RunState */
  private readonly activeRuns = new Map<string, RunState>();
  /** 待审批记录：runId → Approval */
  private readonly pendingApprovals = new Map<string, Approval>();
  /** 已发送审批消息跟踪：runId → true（防止重复发送） */
  private readonly approvalMessageSent = new Map<string, boolean>();
  /** 群成员昵称缓存：groupId:userId → 群名片或昵称 */
  private readonly memberCache = new Map<string, string>();

  /** 历史存储（随持久化配置变更重建） */
  private historyStore?: ChatHistoryStore;
  private historyStoreKey = '';

  private constructor() {}

  // ===================================================================
  //  事件入口
  // ===================================================================

  /** message-event-group 钩子 */
  public handleGroupMessage(bot: QQBot, msg: GroupMessageWSMSG): void {
    this.handleMessageSafe(bot, msg).catch(error => {
      bot.logger?.error(`[Hermes] 群消息处理失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
  }

  /** message-event-private 钩子 */
  public handlePrivateMessage(bot: QQBot, msg: PrivateMessageWSMSG): void {
    this.handleMessageSafe(bot, msg).catch(error => {
      bot.logger?.error(`[Hermes] 私聊消息处理失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
  }

  /** Discord 频道消息钩子（由 DiscordBridge 调用，发送经注入的委托完成） */
  public handleDiscordMessage(bot: QQBot, message: DiscordMessage, params: DiscordChatParams): void {
    this.handleDiscordMessageSafe(bot, message, params).catch(error => {
      bot.logger?.error(
        `[Hermes] Discord 消息处理失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      );
    });
  }

  // ===================================================================
  //  访问控制与触发
  // ===================================================================

  /** 检查用户是否有权与 Bot 对话 */
  private canChat(route: RouteInfo): boolean {
    const config = getHermesConfig();
    if (route.type === 'discord') {
      // Discord 频道由其桥接的 QQ 群决定是否启用；QQ 用户黑白名单不约束 Discord 用户
      return config.groups.includes(Number(route.groupId));
    }
    const uid = Number(route.userId);
    if (config.blockedUsers.includes(uid)) return false;
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(uid) && !isHermesAdmin(uid)) return false;
    if (route.type === 'group' && !config.groups.includes(Number(route.groupId))) return false;
    return true;
  }

  /** 路由是否指向同一会话域（QQ 群与互通的 Discord 频道按桥接群号对齐） */
  private routeMatches(a: RouteInfo, b: RouteInfo): boolean {
    if (a.type === 'user' || b.type === 'user') return a.type === b.type && a.userId === b.userId;
    return a.groupId !== undefined && a.groupId === b.groupId;
  }

  /** 路由发送者是否为管理员（QQ 侧取 hermes admins ∪ operators，Discord 侧取服务器权限） */
  private isRouteAdmin(route: RouteInfo): boolean {
    if (route.type === 'discord') return route.discord?.isAdmin === true;
    return isHermesAdmin(Number(route.userId));
  }

  /** 检查是否 @了 Bot */
  private hasAtSelf(message: ReceiveMessage): boolean {
    if (!Array.isArray(message)) return false;
    const selfId = this.bot?.getLoginInfoSync()?.user_id;
    if (selfId === undefined) return false;
    return message.some(segment => segment.type === 'at' && String(segment.data.qq) === String(selfId));
  }

  /** 提取消息中的纯文本 */
  private extractText(message: ReceiveMessage | string): string {
    if (typeof message === 'string') return message;
    if (!Array.isArray(message)) return '';
    return message
      .filter(segment => segment.type === 'text')
      .map(segment => (segment.type === 'text' ? segment.data.text : ''))
      .join('')
      .trim();
  }

  /** 发送者展示名：群名片（昵称）或昵称或 QQ 号 */
  private senderLabel(sender: { card?: string; nickname?: string }, userId: string): string {
    const card = sender.card?.trim();
    const nick = sender.nickname?.trim();
    const name = card && nick && card !== nick ? `${card}（${nick}）` : card || nick || userId;
    return `${name} (${userId})`;
  }

  // ===================================================================
  //  会话管理
  // ===================================================================

  private get store(): ChatHistoryStore {
    const config = getHermesConfig();
    const key = `${config.persistHistoryMax}:${config.persistHistoryEnabled}`;
    if (!this.historyStore || this.historyStoreKey !== key) {
      this.historyStore = new ChatHistoryStore(config.persistHistoryMax, config.persistHistoryEnabled);
      this.historyStoreKey = key;
    }
    return this.historyStore;
  }

  /** 获取会话键（QQ 群与互通的 Discord 频道按群共享，私聊按人隔离） */
  private getSessionKey(route: RouteInfo): string {
    return route.type === 'user' ? `user:${route.userId}` : `group:${route.groupId}`;
  }

  /** 获取或创建会话（优先从持久化存储恢复） */
  private getSession(key: string): Session {
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { history: this.store.load(key), sessionVersion: 0 });
    }
    return this.sessions.get(key)!;
  }

  /** 清除会话上下文（内存 + 持久化） */
  private clearSession(route: RouteInfo): number {
    const baseKey = this.getSessionKey(route);
    const session = this.sessions.get(baseKey);
    if (session) {
      session.sessionVersion = (session.sessionVersion || 0) + 1;
      session.history = [];
    }
    this.store.clear(baseKey);
    return session?.sessionVersion || 0;
  }

  /** 追加历史消息（内存 + 持久化），跳过空内容 */
  private appendHistory(key: string, role: string, content: string, userId?: string): void {
    if (!content.trim()) return;
    const config = getHermesConfig();
    const session = this.getSession(key);
    session.history.push({ role, content, ...(userId !== undefined ? { userId } : {}) });
    const max = config.localHistoryMaxMessages * 2;
    if (session.history.length > max) {
      session.history = session.history.slice(-max);
    }
    this.store.save(key, session.history);
  }

  // ===================================================================
  //  OneBot API（QQBot 未封装的少量接口，经 HTTP API 直接调用）
  // ===================================================================

  private async callApi<T>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.bot) throw new Error('bot 未就绪');
    const res = await this.bot.axiosInstance.post(`/${action}`, params);
    const payload = res.data as { retcode?: number; msg?: string; wording?: string; data?: T };
    if (payload?.retcode !== 0) {
      throw new Error(`API 错误 ${payload?.retcode}: ${payload?.msg || payload?.wording || ''}`);
    }
    return payload?.data as T;
  }

  /** 技能执行用的群管理 API 门面 */
  private groupAdminApi(): GroupAdminApi {
    return {
      setGroupBan: (groupId, userId, durationSec) =>
        this.callApi('set_group_ban', { group_id: Number(groupId), user_id: Number(userId), duration: durationSec }),
      setGroupKick: (groupId, userId) =>
        this.callApi('set_group_kick', { group_id: Number(groupId), user_id: Number(userId), reject_add_request: false }),
      setGroupWholeBan: (groupId, enable) =>
        this.callApi('set_group_whole_ban', { group_id: Number(groupId), enable })
    };
  }

  /** 解析群成员名称（群名片 → QQ 昵称 → QQ 号），带缓存 */
  private async resolveMemberName(groupId: string | number, userId: string | number): Promise<string | null> {
    const key = `${groupId}:${userId}`;
    if (this.memberCache.has(key)) return this.memberCache.get(key)!;
    try {
      const info = await this.callApi<OneBotGroupMemberInfo>('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId)
      });
      const name = info.card || info.nickname || String(userId);
      this.memberCache.set(key, name);
      return name;
    } catch {
      return null;
    }
  }

  // ===================================================================
  //  消息发送
  // ===================================================================

  /** 发送文本回复（超长按 maxMessageLength 切分；discord 路由经委托发送） */
  private async sendReply(route: RouteInfo, text: string): Promise<void> {
    if (route.type === 'discord') {
      await route.discord?.send(text, false);
      return;
    }
    if (!this.bot) return;
    const chunks = splitMessageText(text, getHermesConfig().maxMessageLength);
    for (const chunk of chunks) {
      if (route.type === 'group') {
        await this.bot.sendGroupMsg(route.groupId!, [{ type: 'text', data: { text: chunk } }]);
      } else {
        await this.bot.sendPrivateMsg(route.userId, [{ type: 'text', data: { text: chunk } }]);
      }
    }
  }

  /** 发送带引用的文本回复（群聊回复原消息，私聊退化为普通发送；discord 路由引用原消息） */
  private async sendReplyWithMention(route: RouteInfo, text: string, userMsgId: number): Promise<void> {
    if (route.type === 'discord') {
      await route.discord?.send(text, true);
      return;
    }
    if (!this.bot) return;
    if (route.type === 'group' && userMsgId) {
      const chunks = splitMessageText(text, getHermesConfig().maxMessageLength);
      for (const chunk of chunks) {
        await this.bot.sendGroupMsg(route.groupId!, [
          { type: 'reply', data: { id: userMsgId } },
          { type: 'text', data: { text: chunk } }
        ]);
      }
      return;
    }
    await this.sendReply(route, text);
  }

  /** 发送图片（base64，允许已带 base64:// 前缀；discord 路由以附件发送） */
  private async sendReplyImage(route: RouteInfo, imageData: string): Promise<void> {
    if (route.type === 'discord') {
      const base64 = imageData.startsWith('base64://') ? imageData.slice('base64://'.length) : imageData;
      await route.discord?.sendImage(base64);
      return;
    }
    if (!this.bot) return;
    const file = imageData.startsWith('base64://') ? imageData : `base64://${imageData}`;
    try {
      if (route.type === 'group') {
        await this.bot.sendGroupMsg(route.groupId!, [{ type: 'image', data: { file } }]);
      } else {
        await this.bot.sendPrivateMsg(route.userId, [{ type: 'image', data: { file } }]);
      }
    } catch (error) {
      this.bot.logger?.error(`[Hermes] 图片发送失败: ${(error as Error).message}，回退到文字`);
    }
  }

  // ===================================================================
  //  图片处理（Hermes 多模态输入 / MEDIA 标签输出）
  // ===================================================================

  /** 下载远程图片并编码为 base64:// */
  private async downloadImageToBase64(imageUrl: string): Promise<string> {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    return `base64://${Buffer.from(await resp.arrayBuffer()).toString('base64')}`;
  }

  /** 下载远程图片并转成 base64 data URL（Hermes 多模态输入用） */
  private async downloadImageToDataUrl(imageUrl: string): Promise<string> {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = (resp.headers.get('content-type') || '').split(';')[0]!.trim();
    const mime = /^image\//i.test(contentType) ? contentType : mimeFromPath(imageUrl);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  /**
   * 解析图片段为 base64 data URL，全部转为 base64 后传给 Hermes。
   * 优先下载 CDN url / http(s) file，否则读取本地文件。
   * 失败时返回 null（仅保留 [图片] 占位符）。
   */
  private async resolveImageDataUrl(segment: { data: { file: string; url?: string } }): Promise<string | null> {
    const { url, file } = segment.data || {};
    const remote = url || (file && /^https?:\/\//i.test(file) ? file : '');
    if (remote) {
      try {
        return await this.downloadImageToDataUrl(remote);
      } catch (error) {
        this.bot?.logger?.error(`[Hermes] 图片下载失败 ${remote}: ${(error as Error).message}`);
      }
    }
    if (file && !/^https?:\/\//i.test(file)) {
      try {
        const buffer = fs.readFileSync(file);
        return `data:${mimeFromPath(file)};base64,${buffer.toString('base64')}`;
      } catch (error) {
        this.bot?.logger?.error(`[Hermes] 图片本地文件读取失败 ${file}: ${(error as Error).message}`);
      }
    }
    return null;
  }

  /** 将消息段转为文本（用于引用/转发内容），图片段转为 [图片] 并收集图片 */
  private async segmentsToText(segments: Message[] | string, images: string[]): Promise<string> {
    if (typeof segments === 'string') return segments;
    if (!Array.isArray(segments)) return '';
    const config = getHermesConfig();
    const parts: string[] = [];
    for (const segment of segments) {
      switch (segment.type) {
        case 'text':
          parts.push(segment.data.text);
          break;
        case 'at':
          parts.push(String(segment.data.qq) === 'all' ? '@全体成员' : `@${segment.data.qq}`);
          break;
        case 'image': {
          parts.push('[图片]');
          if (config.forwardImages) {
            const url = await this.resolveImageDataUrl(segment);
            if (url) images.push(url);
          }
          break;
        }
        case 'video':
          parts.push('[视频]');
          break;
        case 'record':
          parts.push('[语音]');
          break;
        default:
          break;
      }
    }
    return parts.join('').trim();
  }

  // ===================================================================
  //  进度跟踪
  // ===================================================================

  /** 格式化毫秒为可读时长 */
  private formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
    return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  }

  /** 检查是否应发送进度更新 */
  private shouldSendProgress(run: RunState): boolean {
    if (run.sendingProgress) return false;
    const elapsed = (Date.now() - run.lastProgressSent) / 1000;
    return elapsed >= getHermesConfig().progressRateLimitSec;
  }

  /** 发送进度卡片（渲染失败降级纯文本） */
  private async sendProgressCard(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run || run.sendingProgress) return;
    run.sendingProgress = true;

    const now = Date.now();
    const elapsed = this.formatElapsed(now - run.startedAt);

    try {
      const image = await renderProgressImage({
        tools: run.tools,
        currentTool: run.currentTool,
        messageDelta: run.pendingText || run.messageDelta,
        elapsed
      });
      if (image) {
        await this.sendReplyImage(run.route, image);
        run.lastProgressSent = now;
        return;
      }

      // 文字回退
      const lines: string[] = [`⏳ Hermes 执行中 (${elapsed})`];
      for (const tool of run.tools.slice(-8)) {
        const icon = tool.error ? '❌' : '✅';
        const duration = tool.duration ? ` (${this.formatElapsed(tool.duration)})` : '';
        const preview = tool.preview ? ` → ${tool.preview.slice(0, 80)}` : '';
        lines.push(`${icon} ${tool.name}${duration}${preview}`);
      }
      if (run.currentTool) {
        const preview = run.currentTool.preview ? ` → ${run.currentTool.preview.slice(0, 80)}` : '';
        lines.push(`⏳ ${run.currentTool.name}...${preview}`);
      }
      await this.sendReply(run.route, lines.join('\n'));
      run.lastProgressSent = now;
    } finally {
      run.sendingProgress = false;
    }
  }

  // ===================================================================
  //  消息格式化（富文本 → AI 可理解的文本 + 图片）
  // ===================================================================

  /** 格式化 Unix 时间戳 */
  private formatTime(unixTs: number): string {
    const date = new Date(unixTs * 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * 将 OneBot 消息转换为 AI 可理解的富文本格式：
   * 文本 → 原文；@提及 → @昵称(QQ)；图片 → [图片] + 原图（forwardImages 可关）；
   * 视频/语音 → 占位符；回复引用 → 引用块（含原消息图片）；合并转发 → 逐条引用块。
   */
  private async formatMessage(
    message: ReceiveMessage | string,
    groupId: number | undefined
  ): Promise<FormattedMessage> {
    if (typeof message === 'string') return { text: message, images: [] };
    if (!Array.isArray(message)) return { text: '', images: [] };
    const config = getHermesConfig();

    // 收集所有需要解析昵称的 @提及，并行查询群成员昵称
    const atQqs: string[] = [];
    for (const segment of message) {
      if (segment.type === 'at' && segment.data.qq && String(segment.data.qq) !== 'all') {
        const qq = String(segment.data.qq);
        if (!atQqs.includes(qq)) atQqs.push(qq);
      }
    }
    const nameMap = new Map<string, string>();
    if (atQqs.length > 0 && groupId !== undefined) {
      const results = await Promise.all(atQqs.map(qq => this.resolveMemberName(groupId, qq).catch(() => null)));
      atQqs.forEach((qq, index) => {
        const name = results[index];
        if (name) nameMap.set(qq, name);
      });
    }

    const parts: string[] = [];
    const images: string[] = [];

    for (const segment of message) {
      switch (segment.type) {
        case 'text':
          parts.push(segment.data.text);
          break;
        case 'at': {
          const qq = String(segment.data.qq);
          if (qq === 'all') {
            parts.push('@全体成员');
          } else {
            const name = nameMap.get(qq) || qq || '未知';
            parts.push(`@${name}(${qq})`);
          }
          break;
        }
        case 'image': {
          parts.push('[图片]');
          if (config.forwardImages) {
            const url = await this.resolveImageDataUrl(segment);
            if (url) images.push(url);
          }
          break;
        }
        case 'video':
          parts.push('[视频]');
          break;
        case 'record':
          parts.push('[语音]');
          break;
        case 'reply': {
          const repliedMsgId = segment.data.id;
          if (repliedMsgId) {
            try {
              const original = await this.callApi<OneBotGetMsgResponse>('get_msg', {
                message_id: Number(repliedMsgId)
              });
              if (original) {
                const senderName = original.sender?.nickname || '未知';
                const senderId = original.sender?.user_id || '';
                const time = this.formatTime(original.time);
                const content = await this.segmentsToText(original.message, images);
                parts.push(`> ${senderName}(${senderId}) ${time}\n> ${content}\n`);
              }
            } catch {
              parts.push('> [引用消息获取失败]\n');
            }
          }
          break;
        }
        case 'forward': {
          const forwardId = (segment as ForwardMessage).data.id;
          if (forwardId) {
            try {
              const forward = await this.callApi<OneBotGetForwardMsgResponse>('get_forward_msg', {
                message_id: forwardId
              });
              for (const node of forward.messages || []) {
                // NapCat 节点格式: {type:"node", data:{...}}；go-cqhttp / OneBot v11 旧格式: {sender, time, content}
                const merged = (node.type === 'node' ? node.data : node) as OneBotForwardNode['data'] & {
                  sender?: { user_id?: number; nickname?: string; card?: string };
                };
                const nodeSegments = merged?.message?.length ? merged.message : merged?.content || [];
                const nodeName =
                  merged?.nickname || merged?.card || merged?.sender?.nickname || String(merged?.user_id ?? '未知');
                const nodeId = String(merged?.user_id ?? merged?.sender?.user_id ?? '');
                const nodeTime = merged?.time ? this.formatTime(merged.time) : '';
                const content = await this.segmentsToText(nodeSegments, images);
                parts.push(`> ${nodeName}(${nodeId}) ${nodeTime}\n> ${content}\n`);
              }
            } catch {
              parts.push('> [转发消息获取失败]\n');
            }
          }
          break;
        }
        default:
          break;
      }
    }

    return { text: parts.join('').trim(), images };
  }

  // ===================================================================
  //  消息处理主入口
  // ===================================================================

  private async handleMessageSafe(bot: QQBot, msg: GroupMessageWSMSG | PrivateMessageWSMSG): Promise<void> {
    // 防自环：NapCat 配置回报自身消息时直接忽略
    if (msg.user_id === msg.self_id) return;
    this.bot = bot;

    const route: RouteInfo =
      msg.message_type === 'group'
        ? { type: 'group', groupId: String(msg.group_id), userId: String(msg.sender.user_id) }
        : { type: 'user', userId: String(msg.sender.user_id) };

    if (!this.canChat(route)) return;

    const config = getHermesConfig();
    const rawText = this.extractText(msg.message);

    // 审批回复优先于触发判定（仅管理员的选择类文本会被拦截，避免误伤正常聊天）
    if (rawText && (await this.handleApprovalReply(route, rawText, msg.message_id))) return;

    // 触发判定：私聊始终触发；群聊按 @提及/关键词/requireMention（含命令守卫）
    let triggered = true;
    let reason = 'private';
    if (route.type === 'group') {
      const decision = decideGroupTrigger({
        text: rawText,
        mentioned: this.hasAtSelf(msg.message),
        requireMention: config.requireMention,
        keywordTriggers: config.keywordTriggers
      });
      triggered = decision.triggered;
      reason = decision.reason ?? '';

      if (!triggered) {
        // 未触发但群聊消息仍需记录到背景上下文（供 AI 感知群聊氛围）
        if (rawText) {
          this.appendHistory(this.getSessionKey(route), 'user', `${this.senderLabel(msg.sender, route.userId)}: ${rawText}`, route.userId);
        }
        return;
      }
    }

    bot.logger?.info(`[Hermes] 触发: ${reason} from ${route.userId} in ${route.type}:${route.groupId || route.userId}`);

    const formatted = await this.formatMessage(msg.message, msg.message_type === 'group' ? msg.group_id : undefined);
    const text = formatted.text;
    if (!text) return;

    // 停止命令
    if (isStopCommand(text)) {
      await this.handleStopCommand(route);
      return;
    }

    // 清除上下文命令
    if (isResetCommand(text)) {
      const newVersion = this.clearSession(route);
      await this.sendReplyWithMention(route, `✅ 上下文已清除，开始新对话 (v${newVersion})`, msg.message_id);
      return;
    }

    await this.startHermesRun(
      bot,
      route,
      text,
      formatted.images,
      this.senderLabel(msg.sender, route.userId),
      msg.message_id
    );
  }

  // ===================================================================
  //  Discord 消息处理
  // ===================================================================

  /** Discord 消息处理主入口（与 QQ 共用触发/审批/会话逻辑） */
  private async handleDiscordMessageSafe(bot: QQBot, message: DiscordMessage, params: DiscordChatParams): Promise<void> {
    if (message.author.bot || message.webhookId) return;
    this.bot = bot;

    const route: RouteInfo = {
      type: 'discord',
      groupId: params.groupId,
      userId: `dc:${message.author.id}`,
      channelId: message.channelId,
      discord: params
    };
    if (!this.canChat(route)) return;

    const config = getHermesConfig();
    const rawText = this.plainDiscordText(message, params.botUserId);

    // 审批回复优先于触发判定（仅管理员的选择类文本会被拦截）
    if (rawText && (await this.handleApprovalReply(route, rawText, 0))) return;

    const mentioned = params.botUserId ? message.mentions.has(params.botUserId) : false;
    const decision = decideGroupTrigger({
      text: rawText,
      mentioned,
      requireMention: config.requireMention,
      keywordTriggers: config.keywordTriggers
    });

    const displayName = message.member?.displayName ?? message.author.username;
    const label = this.senderLabel({ nickname: displayName }, route.userId);

    if (!decision.triggered) {
      // 未触发的频道消息记录到共享会话的背景上下文（AI 可感知两侧对话）
      if (rawText) {
        this.appendHistory(this.getSessionKey(route), 'user', `${label}: ${rawText}`, route.userId);
      }
      return;
    }

    bot.logger?.info(
      `[Hermes] 触发: ${decision.reason} from ${route.userId} in discord:${params.guildName}#${params.channelName}`
    );

    const formatted = await this.formatDiscordMessage(message, params.botUserId);
    const text = formatted.text;
    if (!text) return;

    if (isStopCommand(text)) {
      await this.handleStopCommand(route);
      return;
    }
    if (isResetCommand(text)) {
      const newVersion = this.clearSession(route);
      await this.sendReplyWithMention(route, `✅ 上下文已清除，开始新对话 (v${newVersion})`, 0);
      return;
    }

    await this.startHermesRun(bot, route, text, formatted.images, label, 0);
  }

  /** Discord 消息正文纯文本化：提及/角色/频道/自定义表情 → 可读文本，并剔除对 bot 的提及 */
  private plainDiscordText(message: DiscordMessage, botUserId?: string): string {
    let text = message.content ?? '';
    if (botUserId) text = text.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '');
    text = text.replace(/<@!?(\d+)>/g, (_match, id: string) => {
      const name = message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.username;
      return `@${name ?? id}(${id})`;
    });
    text = text.replace(/<@&(\d+)>/g, (_match, id: string) => {
      return `@${message.guild?.roles.cache.get(id)?.name ?? id}`;
    });
    text = text.replace(/<#(\d+)>/g, (_match, id: string) => {
      return `#${message.guild?.channels.cache.get(id)?.name ?? id}`;
    });
    text = text.replace(/<a?:(\w{2,32}):\d+>/g, ':$1:');
    return text.trim();
  }

  /**
   * 将 Discord 消息转换为 AI 可理解的富文本格式：
   * 正文 → 可读文本；回复引用 → 引用块（含其中图片）；图片附件 → [图片] + 原图
   * （forwardImages 可关）；其余附件/贴纸 → 占位符。
   */
  private async formatDiscordMessage(message: DiscordMessage, botUserId?: string): Promise<FormattedMessage> {
    const config = getHermesConfig();
    const parts: string[] = [];
    const images: string[] = [];

    const text = this.plainDiscordText(message, botUserId);
    if (text) parts.push(text);

    // 回复引用：拉取被引用消息，转为引用块（含其中图片）
    const referenceId = message.reference?.messageId;
    if (referenceId) {
      try {
        const original = await message.channel.messages.fetch(referenceId);
        const name = original.member?.displayName ?? original.author.username;
        const time = this.formatTime(Math.floor(original.createdTimestamp / 1000));
        const content = this.plainDiscordText(original, botUserId) || '[非文本消息]';
        parts.push(`> ${name}(dc:${original.author.id}) ${time}\n> ${content}\n`);
        if (config.forwardImages) {
          for (const attachment of original.attachments.values()) {
            if (attachment.contentType?.startsWith('image/')) {
              const dataUrl = await this.downloadImageToDataUrlSafe(attachment.url);
              if (dataUrl) images.push(dataUrl);
            }
          }
        }
      } catch {
        parts.push('> [引用消息获取失败]\n');
      }
    }

    // 附件：图片转多模态输入，其余类型占位
    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith('image/')) {
        parts.push('[图片]');
        if (config.forwardImages) {
          const dataUrl = await this.downloadImageToDataUrlSafe(attachment.url);
          if (dataUrl) images.push(dataUrl);
        }
      } else {
        parts.push(`[附件 ${attachment.name}]`);
      }
    }
    if (message.stickers.size > 0) parts.push('[贴纸]');

    return { text: parts.join('\n').trim(), images };
  }

  /** 下载图片为 data URL，失败返回 null（仅保留 [图片] 占位符） */
  private async downloadImageToDataUrlSafe(url: string): Promise<string | null> {
    try {
      return await this.downloadImageToDataUrl(url);
    } catch (error) {
      this.bot?.logger?.error(`[Hermes] Discord 图片下载失败 ${url}: ${(error as Error).message}`);
      return null;
    }
  }

  // ===================================================================
  //  Hermes 运行提交（QQ 与 Discord 共用）
  // ===================================================================

  /** 组装提示词、提交 Hermes 运行并挂接 SSE 事件流 */
  private async startHermesRun(
    bot: QQBot,
    route: RouteInfo,
    text: string,
    images: string[],
    senderLabel: string,
    replyMsgId: number
  ): Promise<void> {
    const config = getHermesConfig();

    // 构建用户提示词（私聊不带发言人前缀）
    const userPrompt = route.type === 'user' ? text : `${senderLabel}: ${text}`;
    // 带图消息：组装 OpenAI 多模态内容段，将原图传给 Hermes
    const userMessage: string | MessageContentPart[] =
      images.length > 0
        ? [
            { type: 'text', text: userPrompt },
            ...images.map((url): MessageContentPart => ({ type: 'image_url', image_url: { url } }))
          ]
        : userPrompt;

    const sessionKey = this.getSessionKey(route);
    const session = this.getSession(sessionKey);
    const sessionVersion = session.sessionVersion || 0;
    // Hermes sessionId 按人区分；群聊/频道日志仍按群共享
    const hermesSessionBase = route.type === 'user' ? `user_${route.userId}` : `group_${route.groupId}_user_${route.userId}`;
    const hermesSessionId = sessionVersion > 0 ? `${hermesSessionBase}:v${sessionVersion}` : hermesSessionBase;

    const historyContent = route.type === 'user' ? text : `${senderLabel}: ${text}`;
    this.appendHistory(sessionKey, 'user', historyContent, route.userId);

    // 组装系统提示词：configs/SOUL.md > systemPrompt > 空 + 群聊上下文 + 技能列表
    const baseSystem = this.loadSoulPrompt() || config.systemPrompt || '';
    const groupContext =
      route.type === 'group'
        ? `你正在 QQ 群 ${route.groupId} 中。群聊有多个成员，不同 QQ 号代表不同的人，请根据发送者标识区分。回复请简短口语化，符合 QQ 聊天风格。`
        : route.type === 'discord'
          ? `你正在 QQ 群 ${route.groupId} 互通的 Discord 频道 #${route.discord?.channelName ?? ''} 中。聊天有多个成员，不同发送者标识代表不同的人（纯数字为 QQ 号，dc: 前缀为 Discord 用户），请根据发送者标识区分。回复请简短口语化。`
          : '';
    const skillsPrompt = this.skillManager.buildPrompt();
    const systemPrompt = [baseSystem, groupContext, skillsPrompt].filter(Boolean).join('\n\n') || undefined;

    try {
      const { runId } = await this.hermes.submitRun({
        userMessage,
        sessionId: hermesSessionId,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        conversationHistory: session.history.slice(0, -1)
      });

      bot.logger?.info(`[Hermes] run 已提交: ${runId}`);

      const runState: RunState = {
        route,
        tools: [],
        currentTool: null,
        startedAt: Date.now(),
        lastProgressSent: 0,
        sendingProgress: false,
        messageDelta: '',
        pendingText: '',
        sentTextLength: 0,
        lastTextSent: 0,
        finalOutput: '',
        userMsgId: replyMsgId
      };
      this.activeRuns.set(runId, runState);

      // 流式输出：工具调用前后自动 flush 中间文本
      const flushPendingText = async () => {
        const pending = runState.pendingText.trim();
        if (!pending) return;
        runState.pendingText = '';
        runState.sentTextLength = runState.messageDelta.length;
        runState.lastTextSent = Date.now();
        try {
          await this.sendReply(runState.route, pending);
        } catch (error) {
          this.bot?.logger?.error(`[Hermes] 文本发送错误: ${(error as Error).message}`);
        }
      };

      const stream = this.hermes.streamEvents(runId, {
        'tool.started': ev => {
          void flushPendingText();
          runState.currentTool = {
            name: ev.tool,
            ...(ev.preview !== undefined ? { preview: ev.preview } : {}),
            startedAt: ev.timestamp * 1000
          };
        },

        'tool.completed': ev => {
          runState.tools.push({
            name: ev.tool,
            duration: (ev.duration || 0) * 1000,
            error: ev.error || false,
            ...(runState.currentTool?.preview !== undefined ? { preview: runState.currentTool.preview } : {})
          });
          runState.currentTool = null;
          void flushPendingText();
        },

        'message.delta': ev => {
          runState.messageDelta += ev.delta || '';
          runState.pendingText += ev.delta || '';

          if (this.shouldSendProgress(runState) && runState.tools.length > 0) {
            this.sendProgressCard(runId).catch(error =>
              this.bot?.logger?.error(`[Hermes] 进度发送错误: ${(error as Error).message}`)
            );
          }
        },

        'approval.request': ev => {
          this.handleApprovalRequest(runId, ev);
        },

        'run.completed': ev => {
          runState.finalOutput = ev.output || '';
        },

        'run.failed': ev => {
          runState.finalOutput = `❌ 执行失败: ${ev.error || '未知错误'}`;
        },

        _end: () => {
          void this.handleRunComplete(runId);
        },

        _error: () => {
          void this.handleRunComplete(runId);
        }
      });

      runState.stream = stream;
    } catch (error) {
      bot.logger?.error(`[Hermes] 提交错误: ${(error as Error).message}`);
      await this.sendReplyWithMention(route, `❌ 调用 Hermes 失败: ${(error as Error).message}`, replyMsgId);
    }
  }

  /** 读取 configs/SOUL.md 作为系统提示词（每次触发时读取，编辑免重启） */
  private loadSoulPrompt(): string {
    try {
      const soulPath = path.resolve(process.cwd(), 'configs', 'SOUL.md');
      if (fs.existsSync(soulPath)) return fs.readFileSync(soulPath, 'utf-8').trim();
    } catch {
      // 读取失败按无 SOUL.md 处理
    }
    return '';
  }

  // ===================================================================
  //  运行完成处理
  // ===================================================================

  /** 处理运行完成：发送最终回复，执行技能标签，处理 MEDIA 标签 */
  private async handleRunComplete(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) return;
    this.activeRuns.delete(runId);
    this.pendingApprovals.delete(runId);
    this.approvalMessageSent.delete(runId);

    let output = run.finalOutput || run.messageDelta;

    // 如果中间已经发过文本，通过与 messageDelta 比对找出未发送的剩余部分
    if (run.sentTextLength > 0 && run.messageDelta && output) {
      const unsentFromDelta = run.messageDelta.slice(run.sentTextLength).trim();
      if (unsentFromDelta) {
        output = unsentFromDelta;
      } else if (output.length > run.sentTextLength) {
        output = output.slice(run.sentTextLength).trim();
      } else {
        return; // 全部已发送
      }
    }

    // 运行没有任何输出（SSE 连接失败 / 模型错误等），通知用户并记录空回复占位
    if (!output?.trim()) {
      const errorMsg = '❌ 执行失败：未收到 Hermes 响应，请稍后重试';
      this.appendHistory(this.getSessionKey(run.route), 'assistant', errorMsg);
      await this.sendReplyWithMention(run.route, errorMsg, run.userMsgId).catch(() => {});
      return;
    }

    // 执行技能标签（管理技能的权限按路由发送者判定：QQ 取 operators，Discord 取服务器权限）
    output = await this.skillManager.processTags(output, run.route, {
      api: this.groupAdminApi(),
      isAdmin: () => this.isRouteAdmin(run.route)
    });
    this.appendHistory(this.getSessionKey(run.route), 'assistant', output);

    // 解析 MEDIA: 标签，发送图片
    const mediaRegex = /MEDIA:((?:\/|https?:\/\/)[^\s\n]+)/g;
    const mediaPaths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mediaRegex.exec(output)) !== null) {
      mediaPaths.push(match[1]!);
    }
    const remainingText = output.replace(/MEDIA:(?:\/|https?:\/\/)[^\s\n]+/g, '').trim();

    for (const mediaPath of mediaPaths) {
      try {
        const imageData =
          mediaPath.startsWith('http://') || mediaPath.startsWith('https://')
            ? await this.downloadImageToBase64(mediaPath)
            : `base64://${fs.readFileSync(mediaPath).toString('base64')}`;
        await this.sendReplyImage(run.route, imageData);
      } catch (error) {
        this.bot?.logger?.error(`[Hermes] 图片发送失败 ${mediaPath}: ${(error as Error).message}`);
      }
    }

    if (remainingText) {
      await this.sendReplyWithMention(run.route, remainingText, run.userMsgId);
    }
  }

  // ===================================================================
  //  停止命令
  // ===================================================================

  /** 处理停止命令（QQ 群与互通的 Discord 频道按会话域匹配，可互相停止） */
  private async handleStopCommand(route: RouteInfo): Promise<void> {
    for (const [runId, run] of this.activeRuns) {
      if (this.routeMatches(route, run.route)) {
        await this.hermes.stopRun(runId);
        await this.sendReply(route, '已停止当前任务 ✋');
        return;
      }
    }
    await this.sendReply(route, '当前没有正在运行的任务');
  }

  // ===================================================================
  //  审批处理
  // ===================================================================

  /** 处理审批请求 */
  private handleApprovalRequest(runId: string, ev: HermesApprovalEvent): void {
    const config = getHermesConfig();
    if (!config.approvalEnabled) return;

    const run = this.activeRuns.get(runId);
    if (!run) return;

    // 防止同一 run 重复发送审批消息（仍更新待审批数据，工具可能被多次调用）
    if (this.approvalMessageSent.has(runId)) {
      this.pendingApprovals.set(runId, { runId, route: run.route, data: ev, createdAt: Date.now() });
      return;
    }

    const route = run.route;
    const command = ev.command || '未知命令';
    const patternKey = ev.pattern_key || '';

    const riskLevel = /rm|delete|sudo|chmod|chown|kill|reboot|shutdown/.test(patternKey)
      ? 'high'
      : /curl|wget|pip|npm|apt|docker/.test(patternKey)
        ? 'medium'
        : 'low';

    const approval: Approval = { runId, route, data: ev, createdAt: Date.now() };
    this.pendingApprovals.set(runId, approval);
    this.approvalMessageSent.set(runId, true);

    if (config.approvalTimeoutSec > 0) {
      approval.timeoutTimer = setTimeout(() => {
        void (async () => {
          if (this.pendingApprovals.has(runId)) {
            this.pendingApprovals.delete(runId);
            this.approvalMessageSent.delete(runId);
            try {
              await this.hermes.resolveApproval(runId, 'deny');
              await this.sendReply(route, `⏱️ 审批超时，已自动拒绝: ${command.slice(0, 100)}`);
            } catch {
              // 忽略
            }
          }
        })();
      }, config.approvalTimeoutSec * 1000);
    }

    this.sendApprovalCard(runId, command, riskLevel).catch(error =>
      this.bot?.logger?.error(`[Hermes] 审批卡片错误: ${(error as Error).message}`)
    );
  }

  /** 发送审批卡片（渲染失败降级纯文本） */
  private async sendApprovalCard(runId: string, command: string, riskLevel: string): Promise<void> {
    const approval = this.pendingApprovals.get(runId);
    if (!approval) return;

    const route = approval.route;
    const ev = approval.data;

    const image = await renderApprovalImage({
      command,
      riskLevel,
      toolName: ev.pattern_key || '',
      runId,
      preview: ev.description || ''
    });

    if (image) {
      await this.sendReplyImage(route, image);
      await this.sendReply(route, `⚠️ 上方命令需要审批。回复 "批准" / "拒绝" / "本次允许" / "始终允许" 来处理。`);
      return;
    }

    const toolName = ev.pattern_key || '';
    const preview = ev.description || '';
    const lines = [
      `⚠️ 需要审批`,
      toolName ? `模式: ${toolName}` : '',
      `命令: ${command.slice(0, 300)}`,
      preview ? `说明: ${preview.slice(0, 200)}` : '',
      riskLevel === 'high' ? `风险: 🔴 高` : riskLevel === 'medium' ? `风险: 🟡 中` : `风险: 🔵 低`,
      '',
      `回复 "批准" / "拒绝" / "本次允许" / "始终允许" 来处理`,
      `(run: ${runId.slice(-8)})`
    ].filter(Boolean);
    await this.sendReply(route, lines.join('\n'));
  }

  /**
   * 处理审批回复（在触发判定之前调用；命中返回 true 表示该消息已作为审批处理）。
   * 仅拦截「同一会话域存在待审批 + 文本可解析为审批选择 + 发送者是管理员」的消息；
   * 非管理员的选择类文本（如 "ok"）不拦截，避免审批等待期间误伤正常聊天。
   * QQ 群与互通的 Discord 频道按会话域匹配，两侧管理员可互相审批。
   */
  private async handleApprovalReply(route: RouteInfo, text: string, msgId: number): Promise<boolean> {
    for (const [runId, approval] of this.pendingApprovals) {
      if (!this.routeMatches(route, approval.route)) continue;

      const choice: ApprovalChoice | null = parseApprovalChoice(text);
      if (!choice) return false;

      // 仅管理员可审批（非管理员不拦截，按普通消息继续走触发/转发流程）
      if (!this.isRouteAdmin(route)) return false;

      if (approval.timeoutTimer) clearTimeout(approval.timeoutTimer);
      this.pendingApprovals.delete(runId);
      this.approvalMessageSent.delete(runId);

      try {
        await this.hermes.resolveApproval(runId, choice);
        const labels: Record<ApprovalChoice, string> = {
          once: '已批准（一次）✅',
          deny: '已拒绝 ❌',
          always: '已设置始终允许 ♾️',
          session: '已允许本次会话 ✅'
        };
        await this.sendReplyWithMention(route, labels[choice], msgId);
      } catch (error) {
        await this.sendReply(route, `审批处理失败: ${(error as Error).message}`);
      }

      return true;
    }
    return false;
  }
}
