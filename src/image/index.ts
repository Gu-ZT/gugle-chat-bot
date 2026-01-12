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

function getIssueState(issue: Issue) {
  if (issue.state == 'open') {
    return `<div class="label" style="display: flex; align-items: center; color:white; background-color: #347D39;">
                <div style="display: flex; align-items: center;">
                  <svg focusable="false" aria-label="Issue" 
                      class="octicon octicon-issue-opened prc-StateLabel-Icon-YICrR" role="img" viewBox="0 0 16 16" 
                      width="16" height="16" fill="currentColor" display="inline-block" 
                      overflow="visible" style="margin-right:4px; vertical-align:text-bottom">
                          <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>
                          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>
                  </svg>
                  Open
                </div>
            </div>\n`;
  } else {
    if (issue.state_reason == 'completed') {
      return `<div class="label" style="display: flex; align-items: center; color:white; background-color: #8256D0;">
                <div style="display: flex; align-items: center;">
                  <svg focusable="false" aria-label="Issue" class="octicon octicon-issue-closed prc-StateLabel-Icon-YICrR"
                   role="img" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" display="inline-block" 
                   overflow="visible" style="margin-right:4px; vertical-align:text-bottom">
                      <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/>
                      <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"></path>
                  </svg>
                  Closed
                </div>
            </div>\n`;
    } else {
      return `<div class="label" style="color:white; background-color: #656C76;">
                <div style="display: flex; align-items: center;">
                  <svg focusable="false" aria-label="Issue, not planned" class="octicon octicon-skip prc-StateLabel-Icon-YICrR"
                   role="img" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" display="inline-block" 
                   overflow="visible" style="margin-right:4px; vertical-align: text-bottom;">
                      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 
                      0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 
                      1.042.018.751.751 0 0 1 .018 1.042Z"/>
                  </svg>
                  Closed
                </div>
            </div>\n`;
    }
  }
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
  const bodies: string[] = (issue.body || '').split('\n');
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
    labelsHtml += `<div class="label" style="color:#${label.color}ff; background-color: #${label.color}55; border:2px solid #${label.color}99">${label.name}</div>\n`;
  }
  let headerExtra: string | undefined = undefined;
  if (sender) {
    headerExtra = `<div class="message">用户<div class="user">${sender.login}</div>${operation}了 </div>`;
  }
  return new Promise<string>((resolve, reject) => {
    Template.load('issue')
      .arg('header extra', headerExtra || '')
      .arg('issue number', issue.number)
      .arg('state label', getIssueState(issue))
      .arg('issue title', issue.title)
      .arg('issue body', issueBody)
      .arg('labels', labelsHtml)
      .arg('extra', extra || '')
      .handler()
      .then(issue => {
        logger?.debug(`Start process issue message...`);
        tryGenerateImage(resolve, reject, issue);
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

function getPullRequestState(pr: PullRequest) {
  if (pr.state == 'open') {
    if (pr.draft) {
      return `<div class="state" style="background-color: #656c76"><svg class="octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"></path></svg> Draft </div>\n`;
    } else {
      return `<div class="state" style="background-color: #238636"><svg class="octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg> Open </div>\n`;
    }
  } else {
    if (pr.merged) {
      return `<div class="state" style="background-color: #8957e5"><svg class="octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"></path></svg> Merged </div>\n`;
    } else {
      return `<div class="state" style="background-color: #da3633"><svg class="octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"></path></svg> Closed </div>\n`
    }
  }
}

function prHandler(pr: PullRequest, logger?: Logger, operation?: string, sender?: User, extra?: string) {
  let prBody = '';
  const bodies: string[] = (pr.body || '<i>No description provided.</i>').split('\n');
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
      .arg('state label', getPullRequestState(pr))
      .arg('extra', extra || '')
      .handler()
      .then(pr => {
        logger?.debug(`Start process pull request message...`);
        tryGenerateImage(resolve, reject, pr);
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

function tryGenerateImage(
  resolve: (value: string | PromiseLike<string>) => void,
  reject: (reason?: any) => void,
  html: string
) {
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
