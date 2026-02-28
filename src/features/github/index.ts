import { EventManager } from 'gugle-event';
import { Logger } from 'winston';
import http from 'node:http';
import { QQBot } from '@/index';
import { AllIssueEvent, AllPullRequestEvent, Issue, PullRequest } from '@/type/github';
import { GitHubImage } from '@/image';
import { GroupMessageWSMSG, Message, SentMessage, TextMessage } from '@/type';

export class Github {
  private readonly bot: QQBot;
  private readonly logger: Logger;
  private readonly eventManager: EventManager;
  private httpServer: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;

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
    this.sendGeneratedImage(bot, 'issue', promise)
  }

  private listenPullRequestEvent(bot: QQBot, msg: AllPullRequestEvent) {
    let promise: Promise<string> | undefined = undefined;
    if (msg.action === 'opened' || msg.action === 'reopened') {
      promise = GitHubImage.prOpened(msg, this.logger);
    } else if (msg.action === 'closed') {
      promise = GitHubImage.prClosed(msg, this.logger);
    }
    this.sendGeneratedImage(bot, 'pull request', promise)
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
        bot.sendGroupMsg(475133231, msg);
        bot.sendGroupMsg(659356928, msg);
        this.logger?.debug(`Sent process ${type} message...`);
      })
      .catch(e => {
        this.logger?.error(e);
      });
  }

  public async post(event: string, ...args: any): Promise<any[]> {
    return await this.eventManager.post(event, ...args);
  }

  public start(port: number): void {
    const self = this;
    this.httpServer.listen(port, () => {
      self.logger?.info(`http server listen on port ${port}`);
    });
  }

  public static processMessage(bot: QQBot, msg: GroupMessageWSMSG, sentMessage: Message[]): Promise<void> {
    if (msg.group_id != 659356928 && msg.group_id != 475133231) return Promise.resolve();
    const receivedMessage: TextMessage[] = [];
    msg.message.forEach(message => {
      if (message.type != 'text') return;
      receivedMessage.push(message);
    });
    const strMsg = receivedMessage.map(msg => msg.data.text).join(' ');
    const numStr = strMsg.match(/#(\d+)/g)?.shift();
    if (!numStr) return Promise.resolve();
    const number = parseInt(numStr.substring(1));
    const issueUrl = `https://gh-proxy.top/https://api.github.com/repos/Anvil-Dev/AnvilCraft/issues/${number}`;
    const pullUrl = `https://gh-proxy.top/https://api.github.com/repos/Anvil-Dev/AnvilCraft/pulls/${number}`;
    return new Promise<void>((resolve, reject) => {
      bot.axiosInstance
        .get(issueUrl)
        .then(response => {
          const data = response.data;
          if (data.pull_request) {
            bot.axiosInstance
              .get(pullUrl)
              .then(response => {
                const data = response.data;
                GitHubImage.prHandler(data as PullRequest, bot.logger)
                  .then(data => {
                    sentMessage.push({
                      type: 'image',
                      data: {
                        file: `data:image/png;base64, ${data}`
                      }
                    });
                    resolve();
                  })
                  .catch(e => {
                    bot.logger?.error(e);
                    reject(e);
                  });
              })
            return;
          }
          GitHubImage.issuesHandler(data as Issue, bot.logger)
            .then(data => {
              sentMessage.push({
                type: 'image',
                data: {
                  file: `data:image/png;base64, ${data}`
                }
              });
              resolve();
            })
            .catch(e => {
              bot.logger?.error(e);
              reject(e);
            });
        })
        .catch(error => {
          bot.logger?.error(error);
          reject(error);
        });
    });
  }
}
