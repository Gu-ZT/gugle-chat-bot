/**
 * Hermes 桥接类型定义（移植自 qq-hermes-bridge src/types.d.ts，MIT 协议，原作者 Amorter）。
 * OneBot 消息段类型复用 @/type，此处只保留 Hermes API / 会话 / 审批 / 技能相关类型。
 */

// ── 路由 ──

/** 消息来源路由：群聊或私聊 */
export interface RouteInfo {
  type: 'group' | 'user';
  groupId?: string;
  userId: string;
}

// ── 会话 ──

/** 对话历史条目 */
export interface HistoryEntry {
  role: string;
  content: string;
  userId?: string;
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
  api: GroupAdminApi;
  route: RouteInfo;
  args: string[];
}

/** 技能定义 */
export interface Skill {
  name: string;
  usage: string;
  description: string;
  adminOnly: boolean;
  execute(ctx: SkillExecuteContext): Promise<string>;
}

/** 技能执行结果 */
export type SkillResult = { ok: true; skill: string; message: string } | { ok: false; skill: string; error: string };

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
