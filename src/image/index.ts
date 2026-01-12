import nodeHtmlToImage from 'node-html-to-image';
import fs from 'node:fs';
import { IssueEvent } from '@/type/github';
import Constants from '@/constants';

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

function getIssuesType(issue: IssueEvent): 'bug' | 'TODO' | 'enhancement' | undefined {
  for (const issueLabel of issue.issue.labels) {
    const issueLabelName = issueLabel.name as string;
    if (issueLabelName.endsWith('bug') || issueLabelName.endsWith('TODO') || issueLabelName.endsWith('enhancement')) {
      return issueLabelName.endsWith('bug') ? 'bug' : issueLabelName.endsWith('TODO') ? 'TODO' : 'enhancement';
    }
  }
  return undefined;
}

function issuesHandler(operation: string, issue: IssueEvent, extra?: string) {
  const type = getIssuesType(issue);
  let issueBody = '';
  const bodies: string[] = issue.issue.body.split('\n');
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
    if (body.startsWith('### Checks - 检查项')) {
      break;
    }
    if (body.startsWith('### ')) {
      issueBody += `<div class='h1'>${body.substring(4)}</div>\n`;
    } else {
      issueBody += `<div class='body'>${body}</div>\n`;
    }
  }
  let labelsHtml = '';
  for (let label of issue.issue.labels) {
    labelsHtml += `<div class="label" style="background-color: #${label.color}55; border:2px solid #${label.color}99">${label.name}</div>\n`;
  }
  return new Promise<string>((resolve, reject) => {
    Template.load('issue')
      .arg('issue user', issue.sender.login)
      .arg('issue number', issue.issue.number)
      .arg('issue title', issue.issue.title)
      .arg('issue body', issueBody)
      .arg('labels', labelsHtml)
      .arg('operation', operation)
      .arg('extra', extra || '')
      .handler()
      .then(issue => {
        // console.log(issue);
        nodeHtmlToImage({
          html: issue,
          puppeteerArgs: {
            executablePath: Constants.CHROME_PATH,
            defaultViewport: {
              width: 1800,
              height: 1
            },
            timeout: 300000
          },
          type: 'png'
        })
          .then(image => {
            // const outputPath = path.join(process.cwd(), 'output.png');
            // fs.writeFileSync(outputPath, image as Buffer);
            // console.log(`图片已保存到: ${outputPath}`);
            resolve(imageToBase64(image as Buffer));
          })
          .catch(reject);
      })
      .catch(reject);
  });
}

function issuesClosed(issue: IssueEvent): Promise<string> {
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
  return issuesHandler('关闭', issue,  extra);
}

function issuesOpened(issue: IssueEvent): Promise<string> {
  return issuesHandler('提交', issue);
}

export class GitHubImage {
  public static issuesOpened(issue: IssueEvent): Promise<string> {
    return issuesOpened(issue);
  }

  public static issuesClosed(issue: IssueEvent): Promise<string> {
    return issuesClosed(issue);
  }
}
