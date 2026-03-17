import process from 'node:process';
import { Logger } from 'winston';
import { RawData, WebSocket } from 'ws';
import { BotConfig } from '@/config';
import Constants from '@/constants';
import fs from 'node:fs';
import dayjs from 'dayjs';
import { LoggerFactory } from '@/logger';
import { EventManager } from 'gugle-event';
import { GroupMessageWSMSG, LoginInfo, LoginInfoData, Message, SentMessage, WSMSG } from '@/type';
import axios, { AxiosInstance } from 'axios';
import { Github } from '@/features/github';
import * as cron from 'node-cron';
import { BotEvent, BotEventCancelable, EventCallback } from '@/type/event';
import { CommandManager, CommandSource } from 'gugle-command';

export class GroupMsgCommandSource implements CommandSource {
  public readonly bot: QQBot;
  public readonly msg: GroupMessageWSMSG;
  private readonly replayMsg: Message[];

  public constructor(bot: QQBot, msg: GroupMessageWSMSG) {
    this.bot = bot;
    this.msg = msg;
    this.replayMsg = [
      {
        type: 'reply',
        data: {
          id: this.msg.message_id
        }
      }
    ];
  }

  public success(message: string): void {
    bot.sendGroupMsg(this.msg.group_id, [
      ...this.replayMsg,
      {
        type: 'text',
        data: {
          text: message
        }
      }
    ]);
  }

  public fail(message: string): void {
    bot.sendGroupMsg(this.msg.group_id, [
      ...this.replayMsg,
      {
        type: 'text',
        data: {
          text: message
        }
      }
    ]);
    bot.logger?.error(`[${this.msg.sender.nickname}|${this.msg.sender.user_id}] ${message}: ${this.msg.raw_message}`);
  }

  public getName(): string {
    return this.msg.sender.nickname;
  }

  public hasPermission(permission: string): boolean {
    if (!permission) return true;
    const getPermissionLevel = (text: string): number => {
      const level = Number.parseInt(text);
      if (Number.isNaN(level)) {
        return text === 'owner' ? 2 : text === 'admin' ? 1 : 0;
      }
      return Number.parseInt(text);
    };
    const permissionLevel: number = getPermissionLevel(this.msg.sender.role);
    const needPermissionLevel: number = getPermissionLevel(permission);
    bot.logger?.debug(
      `permission: ${permission}, role: ${this.msg.sender.role}, permissionLevel: ${permissionLevel}, needPermissionLevel: ${needPermissionLevel}, ${permissionLevel >= needPermissionLevel}`
    );
    return permissionLevel >= needPermissionLevel;
  }
}

export class QQBot {
  private loginInfo?: LoginInfoData = undefined;
  private path: string = process.cwd();
  logger?: Logger;
  private readonly config: BotConfig;
  public readonly axiosInstance: AxiosInstance;
  private readonly ws: WebSocket;
  private readonly eventManager: EventManager;
  private readonly commandManager: CommandManager;
  private wsOpened: boolean = false;
  private lastHeartbeatTime: number = 0;
  private checkHeartbeatFunc?: NodeJS.Timeout = undefined;
  private operationQueue: (() => void)[] = [];
  private lastOperationHandle = -1;

  public constructor(config: BotConfig) {
    this.config = config;
    this.eventManager = new EventManager();
    this.commandManager = new CommandManager();
    this.ws = new WebSocket(`${Constants.WS_URL}/${Constants.TOKEN_PARAMS}${config.wsToken}`);
    this.axiosInstance = axios.create({
      timeout: 15000,
      baseURL: Constants.HTTP_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.httpToken}`,
        'User-Agent': Constants.USER_AGENT
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
        bot.listen('websocket-message', bot.onWebsocketMsg);
        bot.listen('meta-event-heartbeat', bot.onHeartbeat);
        bot.listen('message-event-group', bot.onGroupMsg);
        bot.ws.on('message', rawData => {
          bot.post('websocket-message', bot, rawData);
        });
        bot.getLoginInfo().then(loginInfo => {
          bot.loginInfo = loginInfo;
        });
        bot.post('command-register', bot, this.commandManager).then();
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

  public async post(event: BotEvent, ...args: any): Promise<any[]> {
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

  public listen<T extends BotEvent, C extends BotEventCancelable>(
    event: T,
    callback: EventCallback<T, C>,
    namespace: string = 'gugle-event',
    priority: number = 100,
    cancelable: C = false as C
  ) {
    this.eventManager.listen(event, callback, namespace, priority, cancelable);
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

  private onGroupMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    if (!Constants.FUNCTION_COMMAND_GROUP.includes(msg.group_id)) return;
    const command = msg.raw_message;
    if (!command.startsWith('/')) return;
    bot.commandManager.execute(new GroupMsgCommandSource(bot, msg), command);
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

  public sendGroupMsg(groupId: string | number, message: SentMessage) {
    const bot = this;
    this.operation(() => {
      bot.axiosInstance
        .post(`/send_group_msg`, {
          group_id: groupId,
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

require('@/custom');

bot.start().then(bot => {
  const github = new Github(bot);
  github.start(8848);
});
