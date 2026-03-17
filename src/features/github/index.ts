import { EventManager } from 'gugle-event';
import { Logger } from 'winston';
import http from 'node:http';
import { QQBot } from '@/index';
import { AllIssueEvent, AllPullRequestEvent, Issue, PullRequest } from '@/type/github';
import { GroupMessageWSMSG, Message, SentMessage, TextMessage } from '@/type';
import { GitHubImage } from '@/features/github/image';
import Constants from '@/constants';
import axios, { AxiosInstance } from 'axios';

export class Github {
  private readonly bot: QQBot;
  private readonly logger: Logger;
  private readonly eventManager: EventManager;
  private httpServer: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;

  private static readonly proxies = [
    'https://cdn.gh-proxy.org/',
    'https://gh-proxy.top/',
    'https://gh.noki.icu/',
    'https://gh.dpik.top/',
    'https://tvv.tw/',
    'https://gh.inkchills.cn/',
    'https://git.yylx.win/',
    'https://gh.felicity.ac.cn/',
    'https://github.dpik.top/',
    'https://gh.927223.xyz/',
    'https://cdn.akaere.online/',
    'https://jiashu.1win.eu.org/',
    'https://github.tbedu.top/',
    'https://gh.fhjhy.top/',
    'https://gh.sixyin.com/'
  ];

  public static readonly axiosInstance: AxiosInstance = axios.create({
    timeout: 15000,
    baseURL: Constants.HTTP_URL,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': Constants.USER_AGENT
    }
  });

  private static readonly GITHUB_API_BASE = 'https://api.github.com';

  /**
   * 使用代理轮询请求 GitHub API
   * @param bot QQBot 实例
   * @param apiPath GitHub API 路径（不含域名）
   * @param proxyIndex 当前尝试的代理索引
   * @param errors 累积的错误列表
   * @returns Promise 返回请求数据
   */
  private static requestWithProxyFallback<T>(
    bot: QQBot,
    apiPath: string,
    proxyIndex: number = 0,
    errors: Error[] = []
  ): Promise<T> {
    // 所有代理都失败
    if (proxyIndex >= Github.proxies.length) {
      const errorMsg = `All ${Github.proxies.length} proxies failed. Last errors: ${errors
        .slice(-3)
        .map(e => e.message)
        .join('; ')}`;
      bot.logger?.error(errorMsg);
      return Promise.reject(new Error(errorMsg));
    }

    const proxy = Github.proxies[proxyIndex];
    const url = `${proxy}${Github.GITHUB_API_BASE}${apiPath}`;
    bot.logger?.debug(`Trying proxy: ${proxy}`);
    bot.logger?.debug(`FULL URL: ${url}`);

    return Github.axiosInstance
      .get(url, { timeout: 10000 })
      .then(response => {
        bot.logger?.debug(`Successfully fetched from proxy: ${proxy}`);
        return response.data as T;
      })
      .catch(error => {
        const err = error as Error;
        bot.logger?.warn(`Proxy ${proxy} failed: ${err.message}`);
        errors.push(err);
        // 递归尝试下一个代理
        return Github.requestWithProxyFallback<T>(bot, apiPath, proxyIndex + 1, errors);
      });
  }

  public constructor(bot: QQBot) {
    this.bot = bot;
    this.logger = bot.logger!;
    this.eventManager = new EventManager();
    this.eventManager.listen('github-issues', this.listenIssueEvent.bind(this));
    this.eventManager.listen('github-pull_request', this.listenPullRequestEvent.bind(this));
    this.httpServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString(); // 将数据块拼接成字符串
        });
        req.on('end', () => {
          try {
            const event = (req.headers['x-github-event'] as string) || '';
            body = JSON.parse(body);
            bot.logger?.debug(`Receive Github Event: github-${event}`);
            this.post(`github-${event}`, bot, body);
            res.statusCode = 202;
            res.setHeader('Content-Type', 'text/plain');
            res.end('Accepted');
          } catch (e) {
            bot.logger?.error(e);
          }
        });
        return;
      }
      res.statusCode = 202;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Accepted');
    });
  }

  private listenIssueEvent(bot: QQBot, msg: AllIssueEvent) {
    let promise: Promise<string> | undefined = undefined;
    if (msg.action === 'opened' || msg.action === 'reopened') {
      promise = GitHubImage.issuesOpened(msg, this.logger);
    } else if (msg.action === 'closed') {
      promise = GitHubImage.issuesClosed(msg, this.logger);
    }
    this.sendGeneratedImage(bot, 'issue', promise);
  }

  private listenPullRequestEvent(bot: QQBot, msg: AllPullRequestEvent) {
    let promise: Promise<string> | undefined = undefined;
    if (msg.action === 'opened' || msg.action === 'reopened') {
      promise = GitHubImage.prOpened(msg, this.logger);
    } else if (msg.action === 'closed') {
      promise = GitHubImage.prClosed(msg, this.logger);
    }
    this.sendGeneratedImage(bot, 'pull request', promise);
  }

  private sendGeneratedImage(bot: QQBot, type: string, result: Promise<string> | undefined = undefined) {
    result
      ?.then(base64 => {
        const msg: SentMessage = [
          {
            type: 'image',
            data: {
              file: `data:image/png;base64, ${base64}`
            }
          }
        ];
        Constants.FUNCTION_GITHUB_GROUP.forEach(group => {
          bot.sendGroupMsg(group, msg);
        });
        this.logger?.debug(`Sent process ${type} message...`);
      })
      .catch(e => {
        this.logger?.error(e);
      });
  }

  public post(event: string, ...args: any): Promise<any[]> {
    return this.eventManager.post(event, ...args);
  }

  public start(port: number): void {
    const self = this;
    this.httpServer.listen(port, () => {
      self.logger?.info(`http server listen on port ${port}`);
    });
  }

  public static processMessage(bot: QQBot, msg: GroupMessageWSMSG, sentMessage: Message[]): Promise<void> {
    if (!Constants.FUNCTION_GITHUB_GROUP.includes(msg.group_id)) return Promise.resolve();

    const receivedMessage: TextMessage[] = [];
    msg.message.forEach(message => {
      if (message.type != 'text') return;
      receivedMessage.push(message);
    });

    const strMsg = receivedMessage.map(msg => msg.data.text).join(' ');
    const numStr = strMsg.match(/#(\d+)/g)?.shift();
    if (!numStr) return Promise.resolve();

    const number = parseInt(numStr.substring(1));
    const issueApiPath = `/repos/Anvil-Dev/AnvilCraft/issues/${number}`;
    const pullApiPath = `/repos/Anvil-Dev/AnvilCraft/pulls/${number}`;

    return new Promise<void>((resolve, reject) => {
      // 使用代理轮询获取 issue 数据
      Github.requestWithProxyFallback<Issue & { pull_request?: unknown }>(bot, issueApiPath)
        .then(issueData => {
          if (issueData.pull_request) {
            // 如果是 PR，使用代理轮询获取 PR 数据
            Github.requestWithProxyFallback<PullRequest>(bot, pullApiPath)
              .then(prData => {
                GitHubImage.prHandler(prData, bot.logger)
                  .then(imageData => {
                    sentMessage.push({
                      type: 'image',
                      data: {
                        file: `data:image/png;base64, ${imageData}`
                      }
                    });
                    resolve();
                  })
                  .catch(e => {
                    bot.logger?.error(e);
                    sentMessage.push({
                      type: 'text',
                      data: {
                        text: `图片处理失败，原因：${e.message}`
                      }
                    });
                  });
              })
              .catch(e => {
                bot.logger?.error(e);
                sentMessage.push({
                  type: 'text',
                  data: {
                    text: `请求失败，原因：${e.message}`
                  }
                });
              });
          } else {
            // 处理 issue
            GitHubImage.issuesHandler(issueData as Issue, bot.logger)
              .then(imageData => {
                sentMessage.push({
                  type: 'image',
                  data: {
                    file: `data:image/png;base64, ${imageData}`
                  }
                });
                resolve();
              })
              .catch(e => {
                bot.logger?.error(e);
                sentMessage.push({
                  type: 'text',
                  data: {
                    text: `图片处理失败，原因：${e.message}`
                  }
                });
              });
          }
        })
        .catch(error => {
          bot.logger?.error(error);
          sentMessage.push({
            type: 'text',
            data: {
              text: `请求失败，原因：${error.message}`
            }
          });
        });
    });
  }
}
