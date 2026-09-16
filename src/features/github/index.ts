import { EventManager } from 'gugle-event';
import { Logger } from 'winston';
import http from 'node:http';
import { QQBot } from '@/index';
import { AllIssueEvent, AllPullRequestEvent, Issue, PullRequest } from '@/type/github';
import { GroupMessageWSMSG, Message, SentMessage, TextMessage } from '@/type';
import { GitHubImage } from '@/features/github/image';
import { botConfig } from '@/config';
import { getGithubSubscribers, isGithubEnabledGroup } from '@/config/features';
import { GitHubBindingManager } from '@/features/github/binding';
import { fetchGithubApi } from '@/features/github/api';
import axios, { AxiosInstance } from 'axios';

export class Github {
  private readonly bot: QQBot;
  private readonly logger: Logger;
  private readonly eventManager: EventManager;
  private httpServer: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;

  public static readonly axiosInstance: AxiosInstance = axios.create({
    timeout: 15000,
    baseURL: botConfig.httpUrl,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': botConfig.userAgent
    }
  });

  /**
   * 请求 GitHub API（经 ghapi.anvilcraft.dev 反代），供 processMessage 使用。
   * @param apiPath GitHub API 路径（不含域名），如 /repos/owner/repo/issues/123
   */
  public static fetchGithubApi<T>(bot: QQBot, apiPath: string): Promise<T> {
    return fetchGithubApi<T>(apiPath, bot.logger);
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
    const repository = msg.repository.full_name;
    this.sendGeneratedImage(bot, repository, 'issue', promise);
  }

  private listenPullRequestEvent(bot: QQBot, msg: AllPullRequestEvent) {
    let promise: Promise<string> | undefined = undefined;
    if (msg.action === 'opened' || msg.action === 'reopened') {
      promise = GitHubImage.prOpened(msg, this.logger);
    } else if (msg.action === 'closed') {
      promise = GitHubImage.prClosed(msg, this.logger);
    }
    const repository = msg.repository.full_name;
    this.sendGeneratedImage(bot, repository, 'pull request', promise);
  }

  /**
   * 把生成的图片推送给订阅了该仓库的群（仓库级路由）。
   * 只发给 github.json 中 repository → 订阅群列表对应的群。
   */
  private sendGeneratedImage(bot: QQBot, repository: string, type: string, result: Promise<string> | undefined = undefined) {
    const subscribers = getGithubSubscribers(repository);
    if (subscribers.length === 0) {
      this.logger?.debug(`No subscribers for repository ${repository}, skip ${type} message...`);
      return;
    }
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
        subscribers.forEach(group => {
          bot.sendGroupMsg(group, msg);
        });
        this.logger?.debug(`Sent process ${type} message of ${repository} to ${subscribers.length} group(s)...`);
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

  private static isAllowedRepository(repository: string): boolean {
    const [owner] = repository.split('/');
    if (owner && GitHubBindingManager.isBoundUsername(owner)) return true;

    return botConfig.githubAllowedRepositories.some(pattern => {
      if (pattern.endsWith('/*')) return repository.startsWith(`${pattern.slice(0, -2)}/`);
      return repository === pattern;
    });
  }

  public static processMessage(bot: QQBot, msg: GroupMessageWSMSG, sentMessage: Message[]): Promise<void> {
    if (!isGithubEnabledGroup(msg.group_id)) return Promise.resolve();

    const receivedMessage: TextMessage[] = [];
    msg.message.forEach(message => {
      if (message.type != 'text') return;
      receivedMessage.push(message);
    });

    const strMsg = receivedMessage.map(msg => msg.data.text).join(' ');
    const issueReference = strMsg.match(/(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/);
    if (!issueReference?.[2]) return Promise.resolve();

    const repository = issueReference[1] || 'Anvil-Dev/AnvilCraft';
    if (!this.isAllowedRepository(repository)) {
      sentMessage.push({
        type: 'text',
        data: {
          text: `仓库 ${repository} 不在允许访问的仓库列表中`
        }
      });
      return Promise.resolve();
    }

    const number = Number.parseInt(issueReference[2], 10);
    const issueApiPath = `/repos/${repository}/issues/${number}`;
    const pullApiPath = `/repos/${repository}/pulls/${number}`;

    return new Promise<void>((resolve, reject) => {
      // 经 ghapi 反代获取 issue 数据
      Github.fetchGithubApi<Issue & { pull_request?: unknown }>(bot, issueApiPath)
        .then(issueData => {
          if (issueData.pull_request) {
            // 如果是 PR，经 ghapi 反代获取 PR 数据
            Github.fetchGithubApi<PullRequest>(bot, pullApiPath)
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
                    resolve();
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
                resolve();
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
                resolve();
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
          resolve();
        });
    });
  }
}
