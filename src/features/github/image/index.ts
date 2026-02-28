import {
  ClosedIssueEvent,
  ClosedPullRequestEvent,
  Issue,
  OpenedIssueEvent,
  OpenedPullRequestEvent,
  PullRequest,
  ReopenedIssueEvent,
  ReopenedPullRequestEvent,
  User
} from '@/type/github';
import { Logger } from 'winston';
import markdownit from 'markdown-it';
import hljs from 'highlight.js';
import { full as emoji } from 'markdown-it-emoji';
import { issuesClosed, issuesHandler, issuesOpened } from '@/features/github/image/impl/issue';
import { prClosed, prHandler, prOpened } from '@/features/github/image/impl/pr';

export function renderMarkdown(body?: string): any {
  const taskLists = require('markdown-it-task-lists');
  const abbr = require('markdown-it-abbr');
  const container = require('markdown-it-container');
  const footnote = require('markdown-it-footnote');
  const ins = require('markdown-it-ins');
  const mark = require('markdown-it-mark');
  const sup = require('markdown-it-sup');
  const sub = require('markdown-it-sub');
  const renderer = markdownit({
    highlight: function (str, lang): any {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return (
            '<pre><code class="hljs">' +
            hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
            '</code></pre>'
          );
        } catch (__) {}
      }

      return '<pre><code class="hljs">' + renderer.utils.escapeHtml(str) + '</code></pre>';
    }
  })
    .use(taskLists)
    .use(abbr)
    .use(container)
    .use(emoji)
    .use(footnote)
    .use(ins)
    .use(mark)
    .use(sup)
    .use(sub);
  return renderer.render(body || '');
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
