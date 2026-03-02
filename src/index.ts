import process from 'node:process';
import { Logger } from 'winston';
import { RawData, WebSocket } from 'ws';
import { BotConfig } from '@/config';
import Constants from '@/constants';
import fs from 'node:fs';
import dayjs from 'dayjs';
import { LoggerFactory } from '@/logger';
import { EventManager } from 'gugle-event';
import { GroupMessageWSMSG, LoginInfo, LoginInfoData, Message, PokeNoticeWSMSG, SentMessage, WSMSG } from '@/type';
import axios, { AxiosInstance } from 'axios';
import { ParenthesesMatching } from '@/features/parentheses';
import { Github } from '@/features/github';
import { Poke } from '@/features/poke';
import * as cron from 'node-cron';
import { BotEvent, BotEventCancelable, EventCallback } from '@/type/event';

export class QQBot {
  private loginInfo?: LoginInfoData = undefined;
  private path: string = process.cwd();
  logger?: Logger;
  private readonly config: BotConfig;
  public readonly axiosInstance: AxiosInstance;
  private readonly ws: WebSocket;
  private readonly eventManager: EventManager;
  private wsOpened: boolean = false;
  private lastHeartbeatTime: number = 0;
  private checkHeartbeatFunc?: NodeJS.Timeout = undefined;
  private operationQueue: (() => void)[] = [];
  private lastOperationHandle = -1;

  public constructor(config: BotConfig) {
    this.config = config;
    this.eventManager = new EventManager();
    this.ws = new WebSocket(`${Constants.WS_URL}/${Constants.TOKEN_PARAMS}${config.wsToken}`);
    this.axiosInstance = axios.create({
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
        bot.ws.on('message', rawData => {
          bot.post('websocket-message', bot, rawData);
        });
        bot.getLoginInfo().then(loginInfo => {
          bot.loginInfo = loginInfo;
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
    this.lastOperationHandle = dayjs().valueOf();
    operation();
  }

  private operation(func: () => void) {
    const time = dayjs().valueOf();
    if (time - this.lastOperationHandle > 2000) {
      func();
      this.lastOperationHandle = time;
    } else {
      this.operationQueue.push(func);
    }
  }

  private onWebsocketMsg(bot: QQBot, data: RawData) {
    const msg: WSMSG = JSON.parse(data.toString('utf-8'));
    bot.logger?.debug(`Received message: ${JSON.stringify(msg)}`);
    if (msg.post_type == 'meta_event') {
      bot.logger?.debug(`post meta event: meta-event-${msg.meta_event_type}`);
      bot.post(`meta-event-${msg.meta_event_type}`, bot, msg).then();
    }
    if (msg.post_type == 'message') {
      bot.logger?.debug(`post message event: message-event-${msg.message_type}`);
      bot.post(`message-event-${msg.message_type}`, bot, msg).then();
    }
    if (msg.post_type == 'notice' && msg.notice_type == 'notify') {
      bot.logger?.debug(`post notice event: notice-event-${msg.sub_type}`);
      bot.post(`notice-event-${msg.sub_type}`, bot, msg).then();
    }
  }

  private onHeartbeat(bot: QQBot, data: RawData) {
    bot.logger?.debug(`Received heartbeat: ${JSON.stringify(data)}`);
    bot.lastHeartbeatTime = Date.now();
    clearTimeout(bot.checkHeartbeatFunc);
    bot.checkHeartbeatFunc = setTimeout(() => bot.checkHeartbeat(bot), 40000);
  }

  // ------------------------------------------------
  // Decorators
  // ------------------------------------------------

  /**
   * 定义一个 cron 装饰器，用于根据给定的 cron 表达式调度任务
   *
   * @param _cron cron 表达式，用于指定任务执行的时间
   * @returns {(executor: (bot: QQBot) => void) => void} 返回一个函数，该函数接受一个执行器函数作为参数，并在指定时间执行该执行器函数
   *
   * @example
   * @ bot.cron('0/30 * * * * *')
   * public cron(bot: HeyBoxBot): void {}
   */
  public cron(_cron: string): (executor: (bot: QQBot) => void) => void {
    // 保存当前实例的引用，以便在后续的执行器函数中使用
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self: QQBot = this;
    // 返回一个函数，该函数负责调度执行器函数
    return function (executor: (bot: QQBot) => void) {
      // 使用 cron 表达式调度任务，当时间匹配时执行执行器函数
      cron.schedule(_cron, () => {
        executor(self);
      });
    };
  }

  /**
   * 定义一个事件订阅装饰器，用于根据事件触发回调
   *
   * @param event {string} 事件名称
   * @param namespace {string} 命名空间，用于组织事件监听器
   * @param priority {number} 优先级，决定事件回调的执行顺序
   * @param cancelable {boolean} 是否可取消，决定是否可以取消事件，为 true 时，处理器第一个参数会传入 Cancelable
   * @returns {(callback: (...args: any) => void) => void} 一个函数，接受事件回调并注册该回调到指定事件
   *
   * @example
   * @ bot.subscribe('after-start', true)
   * public test(cancelable: Cancelable, bot: HeyBoxBot) {}
   */
  public subscribe<T extends BotEvent, C extends BotEventCancelable>(
    event: T,
    cancelable: C = false as C,
    namespace: string = 'gugle-event',
    priority: number = 100
  ): (callback: EventCallback<T, C>) => void {
    return this.eventManager.subscribe(event, namespace, priority, cancelable);
  }

  // ------------------------------------------------
  // API Methods
  // ------------------------------------------------

  public sendPrivateMsg(userID: string | number, message: SentMessage) {
    const bot = this;
    this.operation(() => {
      bot.axiosInstance
        .post(`/send_private_msg`, {
          user_id: userID,
          message: message
        })
        .then();
    });
  }

  public sendGroupMsg(userID: string | number, message: SentMessage) {
    const bot = this;
    this.operation(() => {
      bot.axiosInstance
        .post(`/send_group_msg`, {
          group_id: userID,
          message: message
        })
        .then();
    });
  }

  public ban(groupId: number, userId: number, duration: number) {
    const bot = this;
    this.operation(() => {
      bot.logger?.debug(`ban ${userId} in group ${groupId} for ${duration} seconds`);
      bot.axiosInstance
        .post(`/set_group_ban`, {
          group_id: `${groupId}`,
          user_id: `${userId}`,
          duration: duration
        })
        .then();
    });
  }

  public getLoginInfo(): Promise<LoginInfoData> {
    return new Promise<LoginInfoData>((resolve, reject) => {
      if (!this.loginInfo) {
        this.axiosInstance
          .get<LoginInfo>(`/get_login_info`)
          .then(res => resolve(res.data.data))
          .catch(reject);
      } else {
        resolve(this.loginInfo);
      }
    });
  }
  public getLoginInfoSync(): LoginInfoData | undefined {
    return this.loginInfo;
  }
}

export const bot = new QQBot({
  wsToken: '',
  httpToken: '',
  logLevel: Constants.LOG_LEVEL
});

new (class CustomBot {
  @bot.subscribe('notice-event-poke', false)
  public listenPokeMsg(bot: QQBot, msg: PokeNoticeWSMSG): void {
    const sentMessage: Message[] = [
      {
        type: 'at',
        data: {
          qq: msg.user_id
        }
      },
      {
        type: 'text',
        data: {
          text: ' '
        }
      }
    ];
    Poke.processPokeMsg(bot, msg, sentMessage);
    if (sentMessage.length > 2) {
      if (msg.group_id) {
        bot.sendGroupMsg(msg.group_id, sentMessage);
      } else {
        bot.sendPrivateMsg(msg.user_id, sentMessage);
      }
    }
  }

  @bot.subscribe('message-event-group', false)
  public listenGroupMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    const sentMessage: Message[] = [
      {
        type: 'reply',
        data: {
          id: msg.message_id
        }
      }
    ];
    ParenthesesMatching.parenthesesMatching(msg, sentMessage);
    Github.processMessage(bot, msg, sentMessage).then(() => {
      if (sentMessage.length > 1) {
        bot.sendGroupMsg(msg.group_id, sentMessage);
      }
    });
  }
})();

bot.start().then(bot => {
  const github = new Github(bot);
  github.start(8848);
});
