import { Cancelable } from 'gugle-event';
import { QQBot } from '@/index';
import { GroupMessageWSMSG, PokeNoticeWSMSG, PrivateMessageWSMSG } from '@/type/index';
import { RawData } from 'ws';

/**
 * 定义机器人运行时事件类型的元组
 * 用于标识机器人在不同运行阶段所触发的事件
 */
export declare type BeforeStartEvent = 'before-start';
export declare type AfterStartEvent = 'after-start';
export declare type BeforeStopEvent = 'before-stop';
export declare type AfterStopEvent = 'after-stop';

export declare type BotRuntimeEvent = BeforeStartEvent | AfterStartEvent | BeforeStopEvent | AfterStopEvent;

/**
 * 定义HeyBox事件类型的元组
 * 用于标识HeyBox特定事件，如命令消息、用户表情反应等
 */
export declare type GroupMessageEvent = 'message-event-group';
export declare type PrivateMessageEvent = 'message-event-private';
export declare type PokeNoticeEvent = 'notice-event-poke';

export declare type QQEvent = GroupMessageEvent | PrivateMessageEvent | PokeNoticeEvent;

/**
 * 定义机器人所有事件类型的元组
 * 用于标识机器人在不同阶段所触发的事件，包括运行时事件、WebSocket消息事件和HeyBox事件
 */
export declare type WebSocketMessageEvent = 'websocket-message';

export declare type BotEvent = BotRuntimeEvent | WebSocketMessageEvent | QQEvent | string;

/**
 * 定义事件是否可取消的类型
 * 用于指示事件处理函数是否支持取消事件的默认行为
 */
export declare type BotEventCancelable = boolean;

/**
 * 定义机器人运行时事件的回调函数类型
 * 根据事件类型和是否可取消，决定回调函数的参数和返回类型
 */
export declare type BotRuntimeEventCallback<
  T extends BotRuntimeEvent,
  C extends BotEventCancelable
> = T extends 'before-start'
  ? C extends true
    ? (cancelable: Cancelable, bot: QQBot, path: string) => void
    : (bot: QQBot, path: string) => void
  : C extends true
    ? (cancelable: Cancelable, bot: QQBot) => void
    : (bot: QQBot) => void;

declare type GroupMessageEventCallback<T extends GroupMessageEvent, C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: GroupMessageWSMSG) => void
  : (bot: QQBot, message: GroupMessageWSMSG) => void;

declare type PrivateMessageEventCallback<T extends PrivateMessageEvent, C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: PrivateMessageWSMSG) => void
  : (bot: QQBot, message: PrivateMessageWSMSG) => void;

declare type PokeNoticeEventCallback<T extends PokeNoticeEvent, C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: PokeNoticeWSMSG) => void
  : (bot: QQBot, message: PokeNoticeWSMSG) => void;

export type GeneralEventCallback<T extends BotEvent, C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, ...args: any) => void
  : (...args: any) => void;

/**
 * 定义HeyBox事件的回调函数类型
 * 根据事件类型和是否可取消，决定回调函数的参数和返回类型
 */
export declare type QQEventCallback<T extends QQEvent, C extends BotEventCancelable> = T extends GroupMessageEvent
  ? GroupMessageEventCallback<T, C>
  : T extends PrivateMessageEvent
    ? PrivateMessageEventCallback<T, C>
    : T extends PokeNoticeEvent
      ? PokeNoticeEventCallback<T, C>
      : GeneralEventCallback<T, C>;

declare type WebSocketMessageEventCallback<
  T extends WebSocketMessageEvent,
  C extends BotEventCancelable
> = C extends true ? (cancelable: Cancelable, bot: QQBot, data: RawData) => void : (bot: QQBot, data: RawData) => void;

/**
 * 定义通用事件回调函数类型
 * 根据事件类型和是否可取消，决定回调函数的参数和返回类型
 */
export declare type EventCallback<T extends BotEvent, C extends BotEventCancelable> = T extends BotRuntimeEvent
  ? BotRuntimeEventCallback<T, C>
  : T extends WebSocketMessageEvent
    ? WebSocketMessageEventCallback<T, C>
    : T extends QQEvent
      ? QQEventCallback<T, C>
      : GeneralEventCallback<T, C>;
