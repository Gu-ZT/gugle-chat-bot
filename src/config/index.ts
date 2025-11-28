import { QQBot } from '@/index';

export type EventListener = (bot: QQBot, msg: any) => void;

export interface BotConfig {
  logLevel: 'info' | 'error' | 'warn' | 'debug';
  wsToken: string;
  httpToken: string;
  events?: {
    [eventName: string]: EventListener;
  };
}
