import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 触发判定 / 审批选项解析 / 消息切分（纯函数）
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-trigger-'));
process.chdir(tmp);

async function main() {
  const { decideGroupTrigger, parseApprovalChoice, splitMessageText, isStopCommand, isResetCommand } = await import(
    '../src/features/hermes/trigger'
  );

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  const base = { requireMention: true, keywordTriggers: ['小喵', '喵神'] };

  // @提及：无论内容都触发（包括 /命令 文本）
  check('mention', decideGroupTrigger({ ...base, text: '/mcv', mentioned: true }), { triggered: true, reason: 'mention' });
  // 关键词
  check('keyword', decideGroupTrigger({ ...base, text: '小喵你好', mentioned: false }), {
    triggered: true,
    reason: 'keyword:小喵'
  });
  // 命令守卫：/ 或 ! 开头且未 @bot → 不触发（即使命中关键词）
  check('guard-slash', decideGroupTrigger({ ...base, text: '/mcv', mentioned: false }), { triggered: false });
  check('guard-bang-keyword', decideGroupTrigger({ ...base, text: '!小喵', mentioned: false }), { triggered: false });
  // requireMention=true 且无任何命中 → 不触发
  check('no-trigger', decideGroupTrigger({ ...base, text: '普通消息', mentioned: false }), { triggered: false });
  // requireMention=false → 全量触发
  check('bare', decideGroupTrigger({ requireMention: false, keywordTriggers: [], text: '普通消息', mentioned: false }), {
    triggered: true,
    reason: 'bare'
  });

  // 审批选项解析：否定词必须先于肯定词命中（上游顺序缺陷的修正）
  check('approve', parseApprovalChoice('批准'), 'once');
  check('approve-ok', parseApprovalChoice('OK'), 'once');
  check('deny', parseApprovalChoice('拒绝'), 'deny');
  check('deny-negation', parseApprovalChoice('不允许'), 'deny');
  check('deny-negation2', parseApprovalChoice('不批准'), 'deny');
  check('always', parseApprovalChoice('始终允许'), 'always');
  check('session', parseApprovalChoice('本次允许'), 'session');
  check('none', parseApprovalChoice('随便说点什么'), null);

  // 消息切分
  check('split-short', splitMessageText('短消息', 1200), ['短消息']);
  const long = 'a'.repeat(1000) + '\n' + 'b'.repeat(1000);
  const chunks = splitMessageText(long, 1200);
  check('split-count', chunks.length, 2);
  check('split-first-len', chunks[0]!.length, 1000); // 优先在换行处断开
  check('split-join', chunks.join('\n'), long);
  check('split-no-max', splitMessageText('abc', 0), ['abc']);

  // 控制指令
  check('stop-cn', isStopCommand('停止'), true);
  check('stop-en', isStopCommand('STOP'), true);
  check('stop-no', isStopCommand('停止一下'), false);
  check('reset-cn', isResetCommand('清除上下文'), true);
  check('reset-new', isResetCommand('新对话'), true);
  check('reset-en', isResetCommand('reset'), true);
  check('reset-no', isResetCommand('新的对话'), false);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
