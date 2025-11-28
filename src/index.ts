import process from 'node:process';
import { Logger } from 'winston';
import { RawData, WebSocket } from 'ws';
import { BotConfig } from '@/config';
import Constants from '@/constants';
import fs from 'node:fs';
import dayjs from 'dayjs';
import { LoggerFactory } from '@/logger';
import { EventManager } from 'gugle-event';
import { PrivateMessageWSMSG, SentMessage, TextMessage, WSMSG } from '@/type';
import axios, { AxiosInstance } from 'axios';
import { Github } from '@/github/index';

export class QQBot {
  private path: string = process.cwd();
  logger?: Logger;
  private readonly config: BotConfig;
  private readonly AXIOS: AxiosInstance;
  private readonly ws: WebSocket;
  private readonly eventManager: EventManager;
  private wsOpened: boolean = false;
  private lastHeartbeatTime: number = 0;
  private checkHeartbeatFunc?: NodeJS.Timeout = undefined;
  private operationQueue: (() => void)[] = [];

  public constructor(config: BotConfig) {
    this.config = config;
    this.eventManager = new EventManager();
    this.ws = new WebSocket(`${Constants.WS_URL}/${Constants.TOKEN_PARAMS}${config.wsToken}`);
    this.AXIOS = axios.create({
      timeout: 15000,
      baseURL: Constants.HTTP_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.httpToken}`
      }
    });
    this.ws.on('error', (e: Error) => {
      let message = e.message;
      const stack = e.stack;
      if (message.endsWith('401')) {
        this.logger?.error(`${stack}`);
        message = '无法连接至 WebSocket 服务器，请检查你的 Token！ ';
        throw new Error(message);
      }
      throw e;
    });
    this.ws.on('open', () => {
      // 标记WebSocket连接已打开
      this.wsOpened = true;
      this.checkHeartbeatFunc = setTimeout(() => this.checkHeartbeat(this), 40000);
    });
    setInterval(() => this.handlerOperationQueue(this), 2000);
  }

  public async start(path: string = process.cwd()): Promise<QQBot> {
    const bot = this;
    return new Promise(resolve => {
      bot.post('before-start', bot, path).then(args => {
        path = args[1];
        bot.path = path;
        const logPath = `${bot.path}/logs`;
        if (!fs.existsSync(logPath)) fs.mkdirSync(logPath);
        if (fs.existsSync(`${logPath}/latest.log`)) {
          let logName = `${logPath}/${dayjs().format('YYYY-MM-DD-HH-mm-ss')}.log`;
          let count = 0;
          while (fs.existsSync(logName)) {
            count++;
            logName = `${logPath}/${dayjs().format('YYYY-MM-DD-HH-mm-ss')}-${count}.log`;
          }
          fs.renameSync(`${logPath}/latest.log`, logName);
        }
        bot.logger = LoggerFactory.createLogger('QQBot', logPath, bot.config.logLevel || 'info');
        bot.logger.info(`QQ Bot starting...`);
        bot.eventManager.listen('websocket-message', bot.onWebsocketMsg);
        bot.eventManager.listen('meta-event-heartbeat', bot.onHeartbeat);
        if (bot.config.events) {
          for (let key of Object.keys(bot.config.events)) {
            if (!bot.config.events[key]) continue;
            bot.eventManager.listen(key, bot.config.events[key]);
          }
        }
        bot.ws.on('message', rawData => {
          bot.post('websocket-message', bot, rawData);
        });
        bot.post('after-start', bot).then();
        resolve(bot);
      });
    });
  }

  public stop(): QQBot {
    // 在停止之前触发'before-stop'事件，传递当前实例
    this.post('before-stop', this).then(() => {
      // 如果WebSocket连接是打开的状态，关闭连接
      if (this.wsOpened) this.ws.close();
      // 在停止之后触发'after-stop'事件，传递当前实例
      this.post('after-stop', this).then();
    });
    return this;
  }

  public async post(event: string, ...args: any): Promise<any[]> {
    return await this.eventManager.post(event, ...args);
  }

  private checkHeartbeat(bot: QQBot) {
    if (Date.now() - bot.lastHeartbeatTime > 100000) {
      bot.logger?.error('WebSocket connection lost, reconnecting...');
      bot.ws.terminate();
    } else {
      bot.checkHeartbeatFunc = setTimeout(() => bot.checkHeartbeat(bot), 40000);
    }
  }

  private handlerOperationQueue(bot: QQBot) {
    const operation = bot.operationQueue.shift();
    if (!operation) return;
    operation();
  }

  private onWebsocketMsg(bot: QQBot, data: RawData) {
    const msg: WSMSG = JSON.parse(data.toString('utf-8'));
    bot.logger?.debug(`Received message: ${JSON.stringify(msg)}`);
    if (msg.post_type == 'meta_event') {
      bot.logger?.debug(`post meta event: meta-event-${msg.meta_event_type}`);
      bot.post(`meta-event-${msg.meta_event_type}`, bot, msg);
    }
    if (msg.post_type == 'message') {
      bot.logger?.debug(`post message event: message-event-${msg.message_type}`);
      bot.post(`message-event-${msg.message_type}`, bot, msg);
    }
  }

  private onHeartbeat(bot: QQBot, data: RawData) {
    bot.logger?.debug(`Received heartbeat: ${JSON.stringify(data)}`);
    bot.lastHeartbeatTime = Date.now();
    clearTimeout(bot.checkHeartbeatFunc);
    bot.checkHeartbeatFunc = setTimeout(() => bot.checkHeartbeat(bot), 40000);
  }

  public sendPrivateMsg(userID: string | number, message: SentMessage) {
    const bot = this;
    this.operationQueue.push(() => {
      bot.AXIOS.post(`/send_private_msg`, {
        user_id: userID,
        message: message
      });
    });
  }

  public sendGroupMsg(userID: string | number, message: SentMessage) {
    const bot = this;
    this.operationQueue.push(() => {
      bot.AXIOS.post(`/send_group_msg`, {
        group_id: userID,
        message: message
      });
    });
  }
}

function listenPrivateMsg(bot: QQBot, msg: PrivateMessageWSMSG) {
  const sentMessage: TextMessage[] = [];
  msg.message.forEach(message => {
    if (message.type != 'text') return;
    sentMessage.push(message);
  });
  if (!!sentMessage) bot.sendPrivateMsg(msg.user_id, sentMessage);
}

export const bot = new QQBot({
  wsToken: '',
  httpToken: '',
  logLevel: 'debug',
  events: {
    'message-event-private': listenPrivateMsg
  }
});

bot.start().then(bot => {
  const github = new Github(bot);
  github.start(8848);
});
