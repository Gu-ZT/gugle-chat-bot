import { ChannelType, Client, GatewayIntentBits, Guild, Message as DiscordMessage, TextChannel } from 'discord.js';
import { QQBot } from '@/index';
import { GroupMessageWSMSG, Message } from '@/type';
import { ConfigStore } from '@/config/manager';
import { escapeDiscord, isDiscordMarkdown, renderDiscordMessageToImage } from '@/features/discord-bridge/markdown';

/**
 * QQ 群 ⇄ Discord 频道互通模块。
 *
 * 配置（configs/features/discord-bridge.json，v1，ConfigStore 热重载）：
 * ```json
 * {
 *   "version": 1,
 *   "token": "DISCORD_BOT_TOKEN",
 *   "bridges": {
 *     "940551045929639949#general": {
 *       "group": "659356928",
 *       "need_reply": "false",
 *       "need_cmd": "false"
 *     }
 *   }
 * }
 * ```
 * - key 为 `"服务器ID#频道名称"`（频道名以 Discord 当前名为准，改名需同步改配置）；
 * - `group` 为互通的 QQ 群号；
 * - `need_reply=true`：Discord→QQ 全量转发；QQ→Discord 仅转发「回复桥消息」的回复内容；
 * - `need_cmd=true`：双向普通消息均不转发，仅 `/send <msg> [group|channel]` 与
 *   「回复桥消息」互通（回复会以回复形式回传到对侧）；
 * - `/send` 不填目标时默认发送到配置文件中第一个互通条目的对端。
 *
 * 前置条件：Discord 开发者后台为 bot 开启 Message Content Intent，并邀请入对应服务器。
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface BridgeEntry {
  /** QQ 群号（字符串形式，兼容配置里写成数字） */
  group: string;
  /** true 时 QQ→Discord 仅转发对桥消息的回复 */
  need_reply: string;
  /** true 时双向仅 /send 与对桥消息的回复互通 */
  need_cmd: string;
}

export interface DiscordBridgeConfig {
  version: number;
  token: string;
  /** key: "服务器ID#频道名称" */
  bridges: Record<string, BridgeEntry>;
}

function normalizeBridgeFlag(raw: unknown): string | null {
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (raw === 'true' || raw === 'false') return raw;
  return null;
}

function normalizeDiscordBridgeConfig(raw: unknown): DiscordBridgeConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const token = typeof record.token === 'string' ? record.token : '';
  const bridges: Record<string, BridgeEntry> = {};
  if (record.bridges && typeof record.bridges === 'object' && !Array.isArray(record.bridges)) {
    for (const [key, value] of Object.entries(record.bridges as Record<string, unknown>)) {
      if (!/^\d+#.+$/.test(key)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      let group: string;
      if (typeof entry.group === 'string' && /^\d+$/.test(entry.group)) group = entry.group;
      else if (typeof entry.group === 'number' && Number.isSafeInteger(entry.group)) group = String(entry.group);
      else continue;
      const needReply = normalizeBridgeFlag(entry.need_reply) ?? 'false';
      const needCmd = normalizeBridgeFlag(entry.need_cmd) ?? 'false';
      bridges[key] = { group, need_reply: needReply, need_cmd: needCmd };
    }
  }
  return { version: 1, token, bridges };
}

const bridgeStore = new ConfigStore<DiscordBridgeConfig>({
  path: 'configs/features/discord-bridge.json',
  version: 1,
  factory: () => ({ version: 1, token: '', bridges: {} }),
  normalize: normalizeDiscordBridgeConfig
});

/** 读取互通生效配置（热重载） */
export function getDiscordBridgeConfig(): DiscordBridgeConfig {
  return bridgeStore.get();
}

// ---------------------------------------------------------------------------
// 内存路由表（回复链映射）
// ---------------------------------------------------------------------------

/** 有界 FIFO 缓存：转发消息的 id 映射，容量封顶防止长期运行内存膨胀 */
class BoundedCache<V> {
  private readonly map = new Map<number, V>();

  public constructor(private readonly capacity: number = 2000) {}

  public get(key: number): V | undefined {
    return this.map.get(key);
  }

  public set(key: number, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// DiscordBridge
// ---------------------------------------------------------------------------

const DISCORD_MESSAGE_LIMIT = 2000;
const SEND_COMMAND_PREFIX = '/send';

/** 已解析的互通条目（配置 key 拆分后的视图） */
interface ResolvedBridge {
  key: string;
  guildId: string;
  channelName: string;
  entry: BridgeEntry;
}

export class DiscordBridge {
  private static instance?: DiscordBridge;

  public static getInstance(): DiscordBridge {
    if (!DiscordBridge.instance) DiscordBridge.instance = new DiscordBridge();
    return DiscordBridge.instance;
  }

  private client?: Client;
  private bot?: QQBot;
  private started = false;

  /** QQ 消息 id → Discord 消息 id */
  private readonly discordByQQ = new BoundedCache<string>();
  /** Discord 消息 id → QQ 消息 id */
  private readonly qqByDiscord = new BoundedCache<number>();
  /** 本桥转发到 QQ 的消息 id（回复链 & need_reply/need_cmd 判定） */
  private readonly qqFromBridge = new BoundedCache<true>();
  /** 本桥转发到 Discord 的消息 id（回复链 & need_cmd 判定） */
  private readonly dcFromBridge = new BoundedCache<true>();
  /** 转发到 QQ 的消息 id → 来源 bridge key（同群多频道时回复要回到原频道） */
  private readonly bridgeByQQForward = new BoundedCache<string>();

  private constructor() {}

  /** 该群是否配置了互通条目（QQ 侧 /send 分发与桥接共用同一判定） */
  public static isSendTargetGroup(groupId: number | string): boolean {
    const group = String(groupId);
    return Object.values(getDiscordBridgeConfig().bridges).some(entry => entry.group === group);
  }

  /** after-start 钩子：启动 Discord 客户端（token 为空时禁用本功能） */
  public start(bot: QQBot): void {
    if (this.started) return;
    this.started = true;
    this.bot = bot;
    const token = getDiscordBridgeConfig().token;
    if (!token) {
      bot.logger?.warn('[DiscordBridge] token 未配置（configs/features/discord-bridge.json），互通功能已禁用');
      return;
    }
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });
    this.client.on('messageCreate', message => {
      this.handleDiscordMessage(message).catch(error => {
        this.bot?.logger?.error(
          `[DiscordBridge] 处理 Discord 消息失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
        );
      });
    });
    this.client.on('error', error => {
      this.bot?.logger?.error(`[DiscordBridge] Discord 客户端错误: ${error.message}`);
    });
    this.client.once('clientReady', client => {
      this.bot?.logger?.info(`[DiscordBridge] 已登录 Discord：${client.user.tag}`);
    });
    this.client.login(token).catch(error => {
      this.bot?.logger?.error(
        `[DiscordBridge] Discord 登录失败: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  // -------------------------------------------------------------------------
  // QQ → Discord
  // -------------------------------------------------------------------------

  /** message-event-group 钩子：把 QQ 群消息转发到 Discord（或执行 /send） */
  public handleQQMessage(bot: QQBot, msg: GroupMessageWSMSG): void {
    try {
      // 同一 QQ 群可绑定多个频道：普通消息逐条门控并转发到所有放行的频道
      const bridges = this.resolveAllByGroup(msg.group_id);
      if (bridges.length === 0) return;

      // /send 命令（两个 need_cmd 状态都可用；与全局命令分发互斥，此处独立处理）
      // 仅拦截「/send + 空白/结尾」，/sendxxx 之类的消息仍按普通消息转发
      const raw = msg.raw_message ?? '';
      if (this.isSendCommand(raw)) {
        this.handleSendFromQQ(bot, msg, raw).catch(error => {
          bot.logger?.error(
            `[DiscordBridge] QQ /send 执行失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
          );
        });
        return;
      }

      const replyId = this.extractQQReplyId(msg);
      // 「对桥消息的回复」需定位到该桥消息来自的频道（回复要回到原频道）
      const replyBridge = replyId !== undefined ? this.bridgeByQQForward.get(replyId) : undefined;
      const isReplyToBridge = replyBridge !== undefined;

      for (const bridge of bridges) {
        // 门控：need_cmd / need_reply 任一开启时，仅放行「对（该频道）桥消息的回复」
        if (bridge.entry.need_cmd === 'true' || bridge.entry.need_reply === 'true') {
          if (!isReplyToBridge || replyBridge !== bridge.key) continue;
        }
        this.forwardQQToDiscord(bot, msg, bridge, replyId).catch(error => {
          bot.logger?.error(
            `[DiscordBridge] QQ→Discord 转发失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
          );
        });
      }
    } catch (error) {
      bot.logger?.error(
        `[DiscordBridge] QQ 消息处理异常: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      );
    }
  }

  /** 提取 QQ 消息中的回复目标 id（reply 段不计入正文） */
  private extractQQReplyId(msg: GroupMessageWSMSG): number | undefined {
    if (!Array.isArray(msg.message)) return undefined;
    const reply = msg.message.find(segment => segment.type === 'reply');
    if (!reply) return undefined;
    const id = Number(reply.data.id);
    return Number.isSafeInteger(id) ? id : undefined;
  }

  /** QQ 消息段 → Discord 文本（含直链附件行） */
  private buildDiscordTextFromQQ(msg: GroupMessageWSMSG): string {
    const parts: string[] = [];
    if (Array.isArray(msg.message)) {
      for (const segment of msg.message) {
        switch (segment.type) {
          case 'text':
            parts.push(segment.data.text);
            break;
          case 'at':
            parts.push(`@${segment.data.qq}`);
            break;
          case 'face':
            parts.push('[表情]');
            break;
          case 'image':
          case 'record':
          case 'video':
          case 'file': {
            const url = segment.data.url || segment.data.file;
            if (url && /^https?:\/\//.test(url)) parts.push(url);
            break;
          }
          default:
            break;
        }
      }
    }
    return parts.join('').trim();
  }

  /** QQ→Discord 转发主流程 */
  private async forwardQQToDiscord(
    bot: QQBot,
    msg: GroupMessageWSMSG,
    bridge: ResolvedBridge,
    replyId?: number,
    viaCommand: boolean = false
  ): Promise<void> {
    if (!this.client) return;
    const channel = await this.resolveDiscordChannel(bridge);
    if (!channel) return;

    const senderName = msg.sender.card || msg.sender.nickname;
    const header = `【${msg.group_name}|${msg.group_id}】${senderName}(${msg.sender.user_id})：`;
    const body = this.buildDiscordTextFromQQ(msg);
    if (!body) return;

    // QQ 消息符合 Discord markdown → 原文发送（Discord 原生渲染）；否则转义为 plain text
    const rendered = isDiscordMarkdown(body) ? body : escapeDiscord(body);
    const content = this.truncateDiscord(`${header}\n${rendered}`);

    const referenceId = replyId !== undefined ? this.discordByQQ.get(replyId) : undefined;
    const sent = await channel.send({
      content,
      ...(referenceId ? { reply: { messageReference: referenceId } } : {}),
      allowedMentions: { parse: [], repliedUser: false }
    });
    this.registerDiscordMessage(sent.id, msg.message_id, viaCommand);
    bot.logger?.debug(`[DiscordBridge] QQ→Discord：${msg.group_id} → ${bridge.key}（${sent.id}）`);
  }

  // -------------------------------------------------------------------------
  // Discord → QQ
  // -------------------------------------------------------------------------

  /** messageCreate 回调：把 Discord 频道消息转发到 QQ（或执行 /send） */
  private async handleDiscordMessage(message: DiscordMessage): Promise<void> {
    if (message.author.bot || message.webhookId) return;
    if (message.channel.type !== ChannelType.GuildText) return;
    const guildId = message.guildId;
    if (!guildId) return;

    const bridge = this.resolveByChannel(guildId, message.channel.name);
    if (!bridge) return;

    const raw = message.content ?? '';
    if (this.isSendCommand(raw)) {
      await this.handleSendFromDiscord(message, raw);
      return;
    }

    const referenceId = message.reference?.messageId;
    const referenceKey = referenceId ? this.snowflakeToKey(referenceId) : undefined;
    const isReplyToBridge = referenceKey !== undefined && this.dcFromBridge.get(referenceKey) === true;

    // 门控：need_cmd 开启时仅放行「对桥消息的回复」（need_reply 不限制此方向）
    if (bridge.entry.need_cmd === 'true' && !isReplyToBridge) return;

    await this.forwardDiscordToQQ(message, bridge, referenceId);
  }

  /** Discord→QQ 转发主流程 */
  private async forwardDiscordToQQ(
    message: DiscordMessage,
    bridge: ResolvedBridge,
    referenceId?: string | null,
    viaCommand: boolean = false
  ): Promise<void> {
    if (!this.bot) return;
    const bot = this.bot;
    const channel = message.channel as TextChannel;
    const guildName = message.guild?.name ?? bridge.guildId;
    const authorName = message.member?.displayName ?? message.author.username;
    const header = `【${guildName}|${channel.name}】${authorName}(${message.author.username})：`;

    const content = message.content ?? '';
    const segments: Message[] = [];

    // 回复链：转发到 QQ 时带 reply 引用
    const replyTarget = referenceId ? this.qqByDiscord.get(this.snowflakeToKey(referenceId)) : undefined;
    if (replyTarget !== undefined) {
      segments.push({ type: 'reply', data: { id: replyTarget } });
    }

    if (content) {
      if (isDiscordMarkdown(content)) {
        // 含 Discord markdown → 渲染为图片转发（头部并入图片）
        try {
          const base64 = await renderDiscordMessageToImage(header, content, message);
          segments.push({ type: 'image', data: { file: `base64://${base64}` } });
        } catch (error) {
          // 渲染失败降级为纯文本转发，保证消息不丢
          bot.logger?.error(
            `[DiscordBridge] markdown 渲染失败，降级纯文本: ${error instanceof Error ? error.message : String(error)}`
          );
          segments.push({ type: 'text', data: { text: `${header}\n${this.plainDiscordContent(message)}` } });
        }
      } else {
        segments.push({ type: 'text', data: { text: `${header}\n${this.plainDiscordContent(message)}` } });
      }
    } else if (segments.length === 0 || message.attachments.size > 0) {
      // 无文字但有附件/纯 embed：补头部行
      segments.push({ type: 'text', data: { text: header } });
    }

    // 附件：图片直接发图片段，其余类型以链接文本行转发
    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith('image/')) {
        segments.push({ type: 'image', data: { file: attachment.url } });
      } else {
        segments.push({ type: 'text', data: { text: `\n[附件] ${attachment.name}: ${attachment.url}` } });
      }
    }

    // 纯 embed 消息兜底
    if (!content && message.attachments.size === 0 && message.embeds.length > 0) {
      const embed = message.embeds[0];
      segments.push({ type: 'text', data: { text: `\n[Embed] ${embed?.title ?? ''} ${embed?.url ?? ''}`.trim() } });
    }

    if (segments.length === 0) return;
    const qqMessageId = await bot.sendGroupMsg(bridge.entry.group, segments);
    if (qqMessageId !== undefined) {
      this.registerQQMessage(qqMessageId, message.id, viaCommand);
      this.bridgeByQQForward.set(qqMessageId, bridge.key);
      bot.logger?.debug(`[DiscordBridge] Discord→QQ：${bridge.key} → ${bridge.entry.group}（${qqMessageId}）`);
    }
  }

  /** Discord 消息正文纯文本化（提及/频道/表情 → 可读文本） */
  private plainDiscordContent(message: DiscordMessage): string {
    let text = message.content;
    text = text.replace(/<@!?(\d+)>/g, (_match, id: string) => {
      const name = message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.username;
      return `@${name ?? id}`;
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

  // -------------------------------------------------------------------------
  // /send <msg> [group|channel]
  // -------------------------------------------------------------------------

  /** 判断文本是否为 /send 命令（/send 后必须为空白或结尾，避免误吞 /sendxxx 消息） */
  private isSendCommand(raw: string): boolean {
    return raw.startsWith(SEND_COMMAND_PREFIX) && (raw.length === SEND_COMMAND_PREFIX.length || /\s/.test(raw[SEND_COMMAND_PREFIX.length]!));
  }

  /**
   * 解析 /send 参数：尾部 token 命中某个 bridge 的 QQ 群号或频道 key
   * （`guildId#channel`，或 `#channel` 后缀唯一匹配）时作为目标，其余为消息正文。
   * 不填目标时默认发送到配置文件中第一个互通条目的对端。
   */
  private parseSendArgs(text: string): { message: string; target?: string } | null {
    const body = text.slice(SEND_COMMAND_PREFIX.length).trim();
    if (!body) return null;
    const tokens = body.split(/\s+/);
    const bridges = getDiscordBridgeConfig().bridges;
    const keys = Object.keys(bridges);
    if (tokens.length >= 2) {
      const last = tokens[tokens.length - 1]!;
      // QQ 群号
      const byGroup = keys.find(key => bridges[key]!.group === last);
      if (byGroup) return { message: tokens.slice(0, -1).join(' ').trim(), target: byGroup };
      // 完整 key
      if (keys.includes(last)) return { message: tokens.slice(0, -1).join(' ').trim(), target: last };
      // #频道名 后缀（唯一匹配）
      if (last.startsWith('#')) {
        const channelName = last.slice(1);
        const matched = keys.filter(key => key.split('#')[1] === channelName);
        const only = matched[0];
        if (matched.length === 1 && only) return { message: tokens.slice(0, -1).join(' ').trim(), target: only };
      }
    }
    return { message: body };
  }

  /** QQ 侧 /send：发送到目标 Discord 频道（或目标 QQ 群） */
  private async handleSendFromQQ(bot: QQBot, msg: GroupMessageWSMSG, raw: string): Promise<void> {
    const parsed = this.parseSendArgs(raw);
    if (!parsed || !parsed.message) {
      bot.sendGroupMsg(msg.group_id, [
        { type: 'reply', data: { id: msg.message_id } },
        { type: 'text', data: { text: `用法：${SEND_COMMAND_PREFIX} <消息> [QQ群号|服务器ID#频道名]` } }
      ]);
      return;
    }
    const targetKey = parsed.target ?? Object.keys(getDiscordBridgeConfig().bridges)[0];
    if (!targetKey) {
      bot.sendGroupMsg(msg.group_id, [{ type: 'text', data: { text: '[DiscordBridge] 尚未配置任何互通频道' } }]);
      return;
    }
    const bridge = this.resolveByKey(targetKey);
    if (!bridge) return;
    await this.forwardQQToDiscord(bot, msg, bridge, undefined, true);
  }

  /** Discord 侧 /send：发送到目标 QQ 群（或目标 Discord 频道） */
  private async handleSendFromDiscord(message: DiscordMessage, raw: string): Promise<void> {
    const parsed = this.parseSendArgs(raw);
    if (!parsed || !parsed.message) {
      await message.reply(`用法：${SEND_COMMAND_PREFIX} <消息> [QQ群号|服务器ID#频道名]`).catch(() => undefined);
      return;
    }
    const targetKey = parsed.target ?? Object.keys(getDiscordBridgeConfig().bridges)[0];
    if (!targetKey) {
      await message.reply('[DiscordBridge] 尚未配置任何互通频道').catch(() => undefined);
      return;
    }
    const bridge = this.resolveByKey(targetKey);
    if (!bridge) return;
    // 来源频道即目标频道时按普通消息处理，避免同频道复读
    await this.forwardDiscordToQQ(message, bridge, null, true);
  }

  // -------------------------------------------------------------------------
  // 路由表与频道解析
  // -------------------------------------------------------------------------

  /** 登记一次 QQ→Discord 转发的 id 映射（回复链用） */
  private registerDiscordMessage(discordId: string, qqId: number, viaCommand: boolean = false): void {
    const key = this.snowflakeToKey(discordId);
    this.discordByQQ.set(qqId, discordId);
    this.qqByDiscord.set(key, qqId);
    this.dcFromBridge.set(key, true);
  }

  /** 登记一次 Discord→QQ 转发的 id 映射（回复链用） */
  private registerQQMessage(qqId: number, discordId: string, viaCommand: boolean = false): void {
    this.qqByDiscord.set(this.snowflakeToKey(discordId), qqId);
    this.discordByQQ.set(qqId, discordId);
    this.qqFromBridge.set(qqId, true);
  }

  /**
   * Discord snowflake 是 19 位十进制数，超出 JS Number 安全整数范围。
   * 回复链映射用十进制字符串数值化（Number 可精确表示的最大范围外的部分按模 2^53 折叠），
   * 碰撞概率可忽略，避免全局改用字符串键；不依赖 BigInt 字面量（target < ES2020）。
   */
  private snowflakeToKey(id: string): number {
    let value = 0;
    const MODULUS = Number.MAX_SAFE_INTEGER + 1;
    for (const char of id) {
      value = (value * 10 + (char.charCodeAt(0) - 48)) % MODULUS;
    }
    return value;
  }

  private resolveByKey(key: string): ResolvedBridge | undefined {
    const entry = getDiscordBridgeConfig().bridges[key];
    if (!entry) return undefined;
    const [guildId, channelName] = key.split('#');
    if (!guildId || !channelName) return undefined;
    return { key, guildId, channelName, entry };
  }

  /** 该 QQ 群绑定的全部互通条目（同群可绑多个频道，普通消息逐条门控） */
  private resolveAllByGroup(groupId: number | string): ResolvedBridge[] {
    const group = String(groupId);
    const bridges = getDiscordBridgeConfig().bridges;
    return Object.keys(bridges)
      .filter(key => bridges[key]!.group === group)
      .map(key => this.resolveByKey(key)!);
  }

  private resolveByChannel(guildId: string, channelName: string): ResolvedBridge | undefined {
    return this.resolveByKey(`${guildId}#${channelName}`);
  }

  /** 解析配置条目对应的 Discord 文本频道（缓存优先，未缓存时按频道名抓取） */
  private async resolveDiscordChannel(bridge: ResolvedBridge): Promise<TextChannel | undefined> {
    if (!this.client) return undefined;
    const guild: Guild | undefined = this.client.guilds.cache.get(bridge.guildId);
    if (!guild) {
      this.bot?.logger?.warn(`[DiscordBridge] 未找到 Discord 服务器 ${bridge.guildId}（${bridge.key}）`);
      return undefined;
    }
    const channel = guild.channels.cache.find(
      item => item.type === ChannelType.GuildText && item.name === bridge.channelName
    );
    if (channel) return channel as TextChannel;
    try {
      const fetched = await guild.channels.fetch();
      const target = fetched?.find(
        item => item?.type === ChannelType.GuildText && item.name === bridge.channelName
      );
      if (target) return target as TextChannel;
    } catch (error) {
      this.bot?.logger?.error(
        `[DiscordBridge] 拉取频道列表失败（${bridge.key}）: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.bot?.logger?.warn(`[DiscordBridge] 未找到 Discord 频道 ${bridge.key}（频道改名需同步配置）`);
    return undefined;
  }

  private truncateDiscord(text: string): string {
    if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
    return `${text.slice(0, DISCORD_MESSAGE_LIMIT - 16)}\n…（消息过长已截断）`;
  }
}
