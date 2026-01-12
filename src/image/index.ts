import nodeHtmlToImage from 'node-html-to-image';
import fs from 'node:fs';
import {
  ClosedIssueEvent,
  ClosedPullRequestEvent,
  Issue,
  IssueEvent,
  OpenedIssueEvent,
  OpenedPullRequestEvent,
  PullRequest,
  PullRequestEvent,
  ReopenedIssueEvent,
  ReopenedPullRequestEvent,
  User
} from '@/type/github';
import Constants from '@/constants';
import { Logger } from 'winston';
import axios from 'axios';

class Template {
  private readonly templateName: string;
  private processor: ((template: string) => string)[] = [];

  public constructor(templateName: string) {
    this.templateName = templateName;
  }

  public static load(templateName: string): Template {
    return new Template(templateName);
  }

  private async loadTemplate(templateName: string): Promise<string> {
    return fs.readFileSync(`src/template/${templateName}.html`, 'utf8');
  }

  public arg(param: string, object: any): Template {
    this.processor.push(template => {
      while (template.includes(`{{${param}}}`)) {
        template = template.replace(`{{${param}}}`, object.toString());
      }
      return template;
    });
    return this;
  }

  public handler(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.loadTemplate(this.templateName)
        .then(template => {
          try {
            this.processor.forEach(processor => {
              template = processor(template);
            });
            resolve(template);
          } catch (e) {
            reject(e);
          }
        })
        .catch(reject);
    });
  }
}

function imageToBase64(image: Buffer<ArrayBufferLike>) {
  return image.toString('base64');
}

function getIssuesType(issue: Issue): 'bug' | 'TODO' | 'enhancement' | undefined {
  for (const issueLabel of issue.labels) {
    const issueLabelName = issueLabel.name as string;
    if (issueLabelName.endsWith('bug') || issueLabelName.endsWith('TODO') || issueLabelName.endsWith('enhancement')) {
      return issueLabelName.endsWith('bug') ? 'bug' : issueLabelName.endsWith('TODO') ? 'TODO' : 'enhancement';
    }
  }
  return undefined;
}

function issuesHandler(issue: Issue, logger?: Logger, operation?: string, sender?: User, extra?: string) {
  const type = getIssuesType(issue);
  let issueBody = '';
  const bodies: string[] = issue.body.split('\n');
  let start = false;
  for (let body of bodies) {
    if (!body.trim()) continue;
    if (!start) {
      if (type == 'bug' && body.startsWith('### Existing behavior')) {
        start = true;
      } else if (type == 'enhancement' && body.startsWith('### What new features do you want?')) {
        start = true;
      } else if (type == 'TODO' && body.startsWith('### Matters to be added to TODO')) {
        start = true;
      } else if (!type) {
        start = true;
      }
    }
    if (!start) continue;
    if (body.startsWith('### Checks') || body.startsWith('### This issue is unique')) {
      break;
    }
    if (body.startsWith('### ')) {
      issueBody += `<div class='h1'>${body.substring(4)}</div>\n`;
    } else {
      issueBody += `<div class='body'>${body}</div>\n`;
    }
  }
  let labelsHtml = '';
  for (let label of issue.labels) {
    labelsHtml += `<div class="label" style="background-color: #${label.color}55; border:2px solid #${label.color}99">${label.name}</div>\n`;
  }
  let headerExtra: string | undefined = undefined;
  if (sender) {
    headerExtra = `<div class="message">用户<div class="user">${sender.login}</div>${operation}了 </div>`;
  }
  return new Promise<string>((resolve, reject) => {
    Template.load('issue')
      .arg('header extra', headerExtra || '')
      .arg('issue number', issue.number)
      .arg('issue title', issue.title)
      .arg('issue body', issueBody)
      .arg('labels', labelsHtml)
      .arg('extra', extra || '')
      .handler()
      .then(issue => {
        logger?.debug(`Start process issue message...`);
        tryGenerateImage(resolve, reject, issue)
      })
      .catch(reject);
  });
}

function issuesClosed(issue: IssueEvent, logger?: Logger): Promise<string> {
  let extra: string | undefined;
  if (issue.issue.state_reason) {
    extra = "<div class='h1'>关闭原因：</div>\n";
  }
  if (issue.issue.state_reason == 'completed') {
    extra += "<div class='body'>已完成</div>\n";
  } else if (issue.issue.state_reason == 'not_planned') {
    extra += "<div class='body'>未计划</div>\n";
  } else if (issue.issue.state_reason == 'duplicate') {
    extra += "<div class='body'>重复</div>\n";
  } else {
    extra += `<div class='body'>${issue.issue.state_reason}</div>\n`;
  }
  return issuesHandler(issue.issue, logger, '关闭', issue.sender, extra);
}

function issuesOpened(issue: OpenedIssueEvent | ReopenedIssueEvent, logger?: Logger): Promise<string> {
  let operation: string;
  if (issue.action == 'reopened') {
    operation = '重新打开';
  } else {
    operation = '提交';
  }
  return issuesHandler(issue.issue, logger, operation, issue.sender);
}

function prHandler(pr: PullRequest, logger?: Logger, operation?: string, sender?: User, extra?: string) {
  let prBody = '';
  const bodies: string[] = pr.body.split('\n');
  for (let body of bodies) {
    if (!body.trim()) continue;
    if (body.startsWith('### ')) {
      prBody += `<div class='h1'>${body.substring(4)}</div>\n`;
    } else {
      prBody += `<div class='body'>${body}</div>\n`;
    }
  }
  let labelsHtml = '';
  for (let label of pr.labels) {
    labelsHtml += `<div class="label" style="background-color: #${label.color}55; border:2px solid #${label.color}99">${label.name}</div>\n`;
  }
  let headerExtra: string | undefined = undefined;
  if (sender) {
    headerExtra = `<div class="message">用户<div class="user">${sender.login}</div>${operation}了 </div>`;
  }
  return new Promise<string>((resolve, reject) => {
    Template.load('pull_request')
      .arg('header extra', headerExtra || '')
      .arg('pr number', pr.number)
      .arg('pr title', pr.title)
      .arg('pr body', prBody)
      .arg('labels', labelsHtml)
      .arg('extra', extra || '')
      .handler()
      .then(pr => {
        logger?.debug(`Start process pull request message...`);
        tryGenerateImage(resolve, reject, pr)
      })
      .catch(reject);
  });
}

function prClosed(pr: PullRequestEvent, logger?: Logger): Promise<string> {
  let operation: string;
  if (pr.pull_request.merged) {
    operation = '合并';
  } else {
    operation = '关闭';
  }
  return prHandler(pr.pull_request, logger, operation, pr.sender);
}

function prOpened(pr: OpenedPullRequestEvent | ReopenedPullRequestEvent, logger?: Logger): Promise<string> {
  let operation: string;
  if (pr.action == 'reopened') {
    operation = '重新打开';
  } else {
    operation = '提交';
  }
  return prHandler(pr.pull_request, logger, operation, pr.sender);
}

export class GitHubImage {
  public static issuesHandler(
    issue: Issue,
    logger?: Logger,
    operation?: string,
    sender?: User,
    extra?: string
  ): Promise<string> {
    return issuesHandler(issue, logger, operation, sender, extra);
  }

  public static prHandler(
    pr: PullRequest,
    logger?: Logger,
    operation?: string,
    sender?: User,
    extra?: string
  ): Promise<string> {
    return prHandler(pr, logger, operation, sender, extra);
  }

  public static issuesOpened(issue: OpenedIssueEvent | ReopenedIssueEvent, logger?: Logger): Promise<string> {
    return issuesOpened(issue, logger);
  }

  public static issuesClosed(issue: ClosedIssueEvent, logger?: Logger): Promise<string> {
    return issuesClosed(issue, logger);
  }

  public static prOpened(pr: OpenedPullRequestEvent | ReopenedPullRequestEvent, logger?: Logger): Promise<string> {
    return prOpened(pr, logger);
  }

  public static prClosed(pr: ClosedPullRequestEvent, logger?: Logger): Promise<string> {
    return prClosed(pr, logger);
  }
}

function tryGenerateImage(resolve: (value: string | PromiseLike<string>) => void, reject: (reason?: any) => void, html: string) {
  try {
    nodeHtmlToImage({
      html: html,
      puppeteerArgs: {
        executablePath: Constants.CHROME_PATH,
        defaultViewport: {
          width: 1800,
          height: 1
        },
        timeout: 60000,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions'
        ]
      },
      type: 'png',
      timeout: 60000,
      waitUntil: 'domcontentloaded'
    })
    .then(image => {
      // const outputPath = path.join(process.cwd(), 'output.png');
      // fs.writeFileSync(outputPath, image as Buffer);
      // console.log(`图片已保存到: ${outputPath}`);
      resolve(imageToBase64(image as Buffer));
    })
    .catch(reject);
  } catch (e) {
    reject(e);
  }
}
