import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 查询技能回喂循环：handleRunComplete 检出 feedback 结果后，
// 中间文本照常发出、工具数据记入历史、以 depth+1 再提交一轮 run；
// 达到 MAX_FEEDBACK_DEPTH 后数据附在回复里兜底，不再提交新 run。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-feedback-'));
process.chdir(tmp);

async function main() {
  // 先落配置再 import（ConfigStore 单例 + fs.watch，避免运行期重建崩溃）
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'hermes.json'),
    JSON.stringify({ version: 1, apiUrl: 'http://127.0.0.1:9', apiKey: '', groups: [1], admins: [] })
  );
  fs.writeFileSync(path.join(tmp, 'configs', 'features', 'management.json'), JSON.stringify({ version: 1, groups: [], operators: [] }));

  const { HermesBridge } = await import('../src/features/hermes/index');
  const bridge = HermesBridge.getInstance() as any;

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  bridge.bot = { logger: { info() {}, warn() {}, error() {}, debug() {} } };

  // 注入测试查询技能（feedback：结果回喂）
  const sm = bridge.skillManager;
  sm.skills.push({
    name: '查天气',
    usage: '查天气',
    description: '测试',
    adminOnly: false,
    feedback: true,
    execute: async () => '晴 25°C'
  });
  sm.skillIndex.set('查天气', sm.skills[sm.skills.length - 1]);

  // 打桩：发送/历史/回喂提交全部截获
  const sentTexts: string[] = [];
  const historyAdded: Array<{ role: string; content: string }> = [];
  const followups: Array<{ text: string; depth: number }> = [];
  bridge.sendReplyImage = async () => {};
  bridge.sendReplyWithMention = async (_route: unknown, text: string) => {
    sentTexts.push(text);
  };
  bridge.sendReply = async () => {};
  bridge.appendHistory = (_key: string, role: string, content: string) => {
    historyAdded.push({ role, content });
  };
  bridge.startHermesRun = async (
    _bot: unknown,
    _route: unknown,
    text: string,
    _images: unknown,
    _senderLabel: unknown,
    _replyMsgId: unknown,
    depth = 0
  ) => {
    followups.push({ text, depth });
  };

  const route = { type: 'group', groupId: '1', userId: '100' };
  const makeRun = (runId: string, finalOutput: string, feedbackDepth: number) =>
    bridge.activeRuns.set(runId, {
      route,
      tools: [],
      currentTool: null,
      startedAt: Date.now(),
      lastProgressSent: 0,
      sendingProgress: false,
      messageDelta: '',
      pendingText: '',
      sentTextLength: 0,
      lastTextSent: 0,
      finalOutput,
      userMsgId: 5,
      senderLabel: '张三 (100)',
      feedbackDepth
    });

  // 首轮：AI 输出含查询标签 → 中间文本发出 + 工具数据记入历史 + 回喂轮提交（depth=1）
  makeRun('run1', '我查一下 [SKILL:查天气]', 0);
  await bridge.handleRunComplete('run1');
  check('round1-intermediate-sent', sentTexts, ['我查一下']);
  check('round1-history-assistant', historyAdded, [{ role: 'assistant', content: '我查一下' }]);
  check('round1-followup-count', followups.length, 1);
  check('round1-followup-depth', followups[0]?.depth, 1);
  check('round1-followup-has-tool-data', followups[0]?.text.includes('[工具结果 查天气]\n晴 25°C'), true);
  check('round1-followup-instruction', followups[0]?.text.includes('不要重复调用相同技能'), true);

  // 回喂轮完成（纯文本回答，无标签）→ 正常发出，不再提交新 run
  sentTexts.length = 0;
  historyAdded.length = 0;
  followups.length = 0;
  makeRun('run2', '今天晴天，25 度，挺舒服的', 1);
  await bridge.handleRunComplete('run2');
  check('round2-final-sent', sentTexts, ['今天晴天，25 度，挺舒服的']);
  check('round2-no-followup', followups.length, 0);
  check('round2-history', historyAdded, [{ role: 'assistant', content: '今天晴天，25 度，挺舒服的' }]);

  // 已达回喂上限仍输出查询标签 → 数据附在回复里兜底，不再提交新 run
  sentTexts.length = 0;
  followups.length = 0;
  makeRun('run3', '再查查 [SKILL:查天气]', 2);
  await bridge.handleRunComplete('run3');
  check('round3-no-followup', followups.length, 0);
  check('round3-fallback-sent', sentTexts, ['再查查\n\n查天气：晴 25°C']);

  // 输出只有标签（无中间文本）→ 不发空消息，直接回喂
  sentTexts.length = 0;
  followups.length = 0;
  makeRun('run4', '[SKILL:查天气]', 0);
  await bridge.handleRunComplete('run4');
  check('round4-no-empty-send', sentTexts, []);
  check('round4-followup', followups.length, 1);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
