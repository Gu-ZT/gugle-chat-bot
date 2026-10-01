/**
 * Hermes 桥接类型定义（移植自 qq-hermes-bridge src/types.d.ts，MIT 协议，原作者 Amorter）。
 * OneBot 消息段类型复用 @/type，此处只保留 Hermes API / 会话 / 审批 / 技能相关类型。
 */

import type { QQBot } from '@/index';

// ── 路由 ──

/**
 * Discord 路由的发送委托（由 DiscordBridge 注入，随 RouteInfo 传递）。
 * HermesBridge 不直接持有 discord.js Client，经委托向原频道发送回复/图片。
 */
export interface DiscordRouteContext {
  guildName: string;
  channelName: string;
  /** 发送者是否为 Discord 侧管理员（服务器拥有者/管理服务器/管理员权限） */
  isAdmin: boolean;
  /** 发送文本；quote=true 时首条引用原始消息 */
  send(text: string, quote: boolean): Promise<void>;
  /** 发送 base64 图片（Discord 附件） */
  sendImage(base64: string): Promise<void>;
}

/** handleDiscordMessage 的调用参数（DiscordRouteContext + 消息元信息） */
export interface DiscordChatParams extends DiscordRouteContext {
  /** 该频道桥接的 QQ 群号（会话共享与启用门控） */
  groupId: string;
  /** bot 的 Discord 用户 ID（@提及检测与剔除） */
  botUserId?: string;
}

/** 消息来源路由：QQ 群聊、QQ 私聊或 Discord 频道 */
export interface RouteInfo {
  type: 'group' | 'user' | 'discord';
  /** QQ 群号；discord 路由为桥接的 QQ 群号（与 QQ 群共享会话上下文） */
  groupId?: string;
  /** QQ 号字符串；discord 路由为 `dc:<Discord用户ID>` */
  userId: string;
  /** discord 路由：频道 ID */
  channelId?: string;
  /** discord 路由：发送委托（DiscordBridge 注入） */
  discord?: DiscordRouteContext;
}

// ── 会话 ──

/** 对话历史条目 */
export interface HistoryEntry {
  role: string;
  content: string;
  /** 发言人（user 消息）或回复对象（assistant 消息）的用户 id */
  userId?: string;
  /** assistant 消息回复对象的发送者标签（用于在历史中标注「你回复 xxx 的话」） */
  label?: string;
}

/** 对话会话 */
export interface Session {
  history: HistoryEntry[];
  sessionVersion: number;
}

// ── 运行状态 ──

/** 活跃运行中的工具调用记录 */
export interface RunToolRecord {
  name: string;
  duration: number;
  error: boolean;
  preview?: string;
}

/** 活跃运行中正在执行的工具 */
export interface RunCurrentTool {
  name: string;
  preview?: string;
  startedAt: number;
}

/** 活跃的 Hermes 运行状态 */
export interface RunState {
  route: RouteInfo;
  tools: RunToolRecord[];
  currentTool: RunCurrentTool | null;
  startedAt: number;
  lastProgressSent: number;
  sendingProgress: boolean;
  messageDelta: string;
  pendingText: string;
  sentTextLength: number;
  lastTextSent: number;
  finalOutput: string;
  userMsgId: number;
  /** 本轮对话发送者的展示标签（assistant 历史据此标注回复对象） */
  senderLabel: string;
  stream?: { abort(): void };
}

// ── 审批 ──

/** 待审批记录 */
export interface Approval {
  runId: string;
  route: RouteInfo;
  data: HermesApprovalEvent;
  createdAt: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

/** 审批选择 */
export type ApprovalChoice = 'once' | 'deny' | 'always' | 'session';

// ── Hermes SSE 事件类型 ──

export interface HermesToolStartedEvent {
  event: 'tool.started';
  run_id: string;
  timestamp: number;
  tool: string;
  preview?: string;
}

export interface HermesToolCompletedEvent {
  event: 'tool.completed';
  run_id: string;
  timestamp: number;
  tool: string;
  duration: number;
  error: boolean;
}

export interface HermesMessageDeltaEvent {
  event: 'message.delta';
  run_id: string;
  timestamp: number;
  delta: string;
}

export interface HermesApprovalEvent {
  event: 'approval.request';
  run_id: string;
  timestamp: number;
  command: string;
  pattern_key?: string;
  description?: string;
}

export interface HermesRunCompletedEvent {
  event: 'run.completed';
  run_id: string;
  timestamp: number;
  output: string;
}

export interface HermesRunFailedEvent {
  event: 'run.failed';
  run_id: string;
  timestamp: number;
  error: string;
}

export interface HermesReasoningEvent {
  event: 'reasoning.available';
  run_id: string;
  timestamp: number;
  text: string;
}

/** Hermes SSE 事件联合类型 */
export type HermesSSEEvent =
  | HermesToolStartedEvent
  | HermesToolCompletedEvent
  | HermesMessageDeltaEvent
  | HermesApprovalEvent
  | HermesRunCompletedEvent
  | HermesRunFailedEvent
  | HermesReasoningEvent;

/** Hermes SSE 事件回调映射 */
export interface HermesEventCallbacks {
  'tool.started'?: (ev: HermesToolStartedEvent) => void;
  'tool.completed'?: (ev: HermesToolCompletedEvent) => void;
  'message.delta'?: (ev: HermesMessageDeltaEvent) => void;
  'approval.request'?: (ev: HermesApprovalEvent) => void;
  'run.completed'?: (ev: HermesRunCompletedEvent) => void;
  'run.failed'?: (ev: HermesRunFailedEvent) => void;
  'reasoning.available'?: (ev: HermesReasoningEvent) => void;
  _end?: () => void;
  _error?: (err: Error) => void;
  _any?: (ev: HermesSSEEvent) => void;
}

// ── 技能系统 ──

/** 群管理 API 门面（由 HermesBridge 基于 QQBot 实现后注入技能） */
export interface GroupAdminApi {
  /** 禁言群成员（durationSec=0 解除） */
  setGroupBan(groupId: string, userId: string, durationSec: number): Promise<unknown>;
  /** 踢出群成员 */
  setGroupKick(groupId: string, userId: string): Promise<unknown>;
  /** 开启/关闭全员禁言 */
  setGroupWholeBan(groupId: string, enable: boolean): Promise<unknown>;
}

/** 技能执行上下文 */
export interface SkillExecuteContext {
  /** QQBot 实例（卡片类技能经其 axiosInstance/logger 访问外部 API 与渲染） */
  bot: QQBot;
  api: GroupAdminApi;
  route: RouteInfo;
  args: string[];
}

/**
 * 技能执行产出：纯文本摘要字符串，或 `{ message, images }`——
 * images 为待发送的 base64 图片（允许带 base64:// 前缀），由完成处理器逐张发出。
 */
export type SkillExecution = string | { message: string; images?: string[] };

/** 技能定义 */
export interface Skill {
  name: string;
  usage: string;
  description: string;
  adminOnly: boolean;
  execute(ctx: SkillExecuteContext): Promise<SkillExecution>;
}

/** 技能执行结果 */
export type SkillResult =
  | { ok: true; skill: string; message: string; images?: string[] }
  | { ok: false; skill: string; error: string };

/** processTags 的返回：清理后的文本 + 全部技能产出的图片 */
export interface ProcessedSkillOutput {
  text: string;
  images: string[];
}

// ── 多模态消息内容 ──

/** OpenAI 风格消息内容段（用于多模态 user_message） */
export type MessageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** formatMessage 的返回：文本 + 提取到的图片列表（均为 base64 data URL） */
export interface FormattedMessage {
  text: string;
  /** base64 data URL（data:image/...;base64,...） */
  images: string[];
}

// ── OneBot API 响应（功能内使用的最小子集） ──

/** get_msg API 返回值 */
export interface OneBotGetMsgResponse {
  message_id: number;
  sender: {
    user_id: number;
    nickname: string;
  };
  time: number;
  message: import('@/type').Message[];
}

/** get_forward_msg 节点（兼容 NapCat node 格式与 go-cqhttp 旧格式） */
export interface OneBotForwardNode {
  type?: 'node';
  data?: {
    user_id?: number;
    nickname?: string;
    card?: string;
    time?: number;
    message?: import('@/type').Message[];
    content?: import('@/type').Message[] | string;
  };
  sender?: { user_id?: number; nickname?: string; card?: string };
  time?: number;
  content?: import('@/type').Message[] | string;
}

/** get_forward_msg API 返回值 */
export interface OneBotGetForwardMsgResponse {
  messages: OneBotForwardNode[];
}

/** get_group_member_info API 返回值 */
export interface OneBotGroupMemberInfo {
  group_id: number;
  user_id: number;
  nickname: string;
  card: string;
  role: string;
}
