import { EventManager } from 'gugle-event';
import { Logger } from 'winston';
import http from 'node:http';
import { QQBot } from '@/index';
import { AllIssueEvent } from '@/type/github';

export class Github {
  private readonly bot: QQBot;
  private readonly logger: Logger;
  private readonly eventManager: EventManager;
  private httpServer: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;

  public constructor(bot: QQBot) {
    this.bot = bot;
    this.logger = bot.logger!;
    this.eventManager = new EventManager();
    this.eventManager.listen('github-issue', this.listenIssueEvent.bind(this));
    this.httpServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString(); // 将数据块拼接成字符串
        });
        req.on('end', () => {
          const event = (req.headers['x-github-event'] as string) || '';
          body = JSON.parse(body);
          bot.logger?.debug(`Receive Github Event: github-${event}`);
          this.post(`github-${event}`, bot, body);
          res.statusCode = 202;
          res.setHeader('Content-Type', 'text/plain');
          res.end('Accepted');
        });
        return;
      }
      res.statusCode = 202;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Accepted');
    });
  }

  private listenIssueEvent(bot: QQBot, msg: AllIssueEvent) {
    if (msg.action === 'opened') {
      bot.sendPrivateMsg(2308465862, [
        {
          type: 'text',
          data: {
            text:
              '有新的 Issue \n' +
              '\n' +
              `🐛 Issue #${msg.issue.number}\n` +
              `📌 ${msg.issue.title}\n` +
              `${msg.issue.user.name}` +
              `🔗 ${msg.issue.user.html_url}`
          }
        }
      ]);
    }
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
}
