import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 群聊发送链路（T3 接线）：逐句发送、单条超 40 字/5 行转聊天记录、
// 引用只贴首条、私聊与 Discord 维持整段、控制类消息不套阈值、
// 流式逐句下发与 [SKILL:/MEDIA: 保留缓冲、finishRun 尾段不重复不丢失。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-send-units-'));
process.chdir(tmp);

/** 捕获到的一次发送 */
interface SentCall {
  kind: 'text' | 'forward' | 'private' | 'discord';
  text: string;
  withReply: boolean;
}

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'hermes.json'),
    JSON.stringify({
      version: 1,
      apiUrl: 'http://127.0.0.1:9',
      groups: [1],
      replyPerSentence: true,
      // 显式固定阈值，使发送链路断言不受默认值调整影响
      compactMaxChars: 40,
      compactMaxLines: 5,
      botName: '小喵'
    })
  );
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'management.json'),
    JSON.stringify({ version: 1, groups: [], operators: [] })
  );

  const { HermesBridge } = await import('../src/features/hermes/index');
  const bridge = HermesBridge.getInstance() as any;

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  };

  // ── 发送桩：记录每次发送的形态与是否带引用 ──
  const sent: SentCall[] = [];
  const forwardCalls: Array<{ groupId: string; nodes: unknown[] }> = [];
  /** 记录文本发送是否失败（用于断言失败后不再重复贴引用） */
  let failTextSend = false;

  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const fakeBot = {
    logger,
    getLoginInfoSync: () => ({ user_id: 10000, nickname: '小喵' }),
    sendGroupMsg: async (_groupId: string, message: Array<{ type: string; data: { text?: string } }>) => {
      if (failTextSend) return undefined;
      const withReply = message.some(segment => segment.type === 'reply');
      const text = message.filter(s => s.type === 'text').map(s => s.data.text ?? '').join('');
      sent.push({ kind: 'text', text, withReply });
      return 1;
    },
    sendPrivateMsg: async (_userId: string, message: Array<{ type: string; data: { text?: string } }>) => {
      const text = message.filter(s => s.type === 'text').map(s => s.data.text ?? '').join('');
      sent.push({ kind: 'private', text, withReply: false });
      return 1;
    },
    sendGroupForwardMsg: async (groupId: string, nodes: Array<{ content: string }>) => {
      forwardCalls.push({ groupId, nodes });
      sent.push({ kind: 'forward', text: nodes.map(n => n.content).join(''), withReply: false });
      return 2;
    },
    axiosInstance: { post: async () => ({ data: { data: {} } }) }
  };
  bridge.bot = fakeBot;

  const groupRoute = { type: 'group', groupId: '1', userId: '100' };
  const privateRoute = { type: 'user', userId: '100' };
  const discordSent: SentCall[] = [];
  const discordRoute = {
    type: 'discord',
    groupId: '1',
    userId: 'dc:1',
    channelId: '9',
    discord: {
      guildName: 'g',
      channelName: 'c',
      isAdmin: false,
      send: async (text: string) => {
        discordSent.push({ kind: 'discord', text, withReply: false });
      },
      sendImage: async () => {}
    }
  };
  const makeRun = (extra: Record<string, unknown> = {}) => ({
    route: groupRoute,
    tools: [],
    currentTool: null,
    startedAt: Date.now(),
    lastProgressSent: 0,
    sendingProgress: false,
    messageDelta: '',
    pendingText: '',
    sentTextLength: 0,
    lastTextSent: 0,
    finalOutput: '',
    userMsgId: 5,
    senderLabel: '张三 (100)',
    feedbackDepth: 0,
    ...extra
  });

  // ── 1. 逐句发送：每句话一条消息，短句不转聊天记录 ──
  await bridge.sendAiReplyUnits(groupRoute, '你好。今天天气不错！', 5, makeRun());
  check(
    'sentence-per-message',
    sent.map(c => [c.kind, c.text]),
    [
      ['text', '你好。'],
      ['text', '今天天气不错！']
    ]
  );
  check('first-unit-quotes', sent.map(c => c.withReply), [true, false]);

  // ── 2. 超 40 字：该句整体转聊天记录，其余短句仍为普通消息 ──
  sent.length = 0;
  forwardCalls.length = 0;
  const long = '甲'.repeat(41);
  await bridge.sendAiReplyUnits(groupRoute, `短的。${long}。`, 5, makeRun());
  check(
    'over-40-chars-forwards',
    sent.map(c => [c.kind, c.text.length]),
    [
      ['text', 3],
      ['forward', 42]
    ]
  );
  check('forward-node-signature', forwardCalls[0]?.nodes?.[0], {
    name: '小喵',
    uin: 10000,
    content: `${long}。`
  });

  // 恰好 40 字不转（边界）
  sent.length = 0;
  await bridge.sendAiReplyUnits(groupRoute, `${'乙'.repeat(39)}。`, 5, makeRun());
  check('exactly-40-stays-text', sent.map(c => c.kind), ['text']);

  // ── 3. 超 5 行：转聊天记录（代码块原子，不被拆碎） ──
  sent.length = 0;
  forwardCalls.length = 0;
  const code = '```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n```';
  await bridge.sendAiReplyUnits(groupRoute, code, 5, makeRun());
  check('over-5-lines-forwards', sent.map(c => c.kind), ['forward']);
  check('code-fence-not-split', forwardCalls[0]?.nodes?.[0]?.content, code);

  // ── 4. 引用只贴首条；文本发送失败也不重复贴引用 ──
  sent.length = 0;
  await bridge.sendAiReplyUnits(groupRoute, '第一句。第二句。第三句。', 5, makeRun());
  check('quote-once', sent.map(c => c.withReply), [true, false, false]);

  sent.length = 0;
  failTextSend = true;
  await bridge.sendAiReplyUnits(groupRoute, '甲。乙。丙。', 5, makeRun());
  failTextSend = false;
  check('no-send-on-failure', sent.length, 0);

  // ── 5. 私聊与 Discord 维持整段发送（不逐句、不转聊天记录） ──
  sent.length = 0;
  await bridge.sendAiReplyUnits(privateRoute, '你好。今天天气不错！', 0, makeRun({ route: privateRoute }));
  check('private-stays-whole', sent.map(c => [c.kind, c.text]), [['private', '你好。今天天气不错！']]);

  sent.length = 0;
  discordSent.length = 0;
  await bridge.sendAiReplyUnits(discordRoute, '你好。今天天气不错！', 0, makeRun({ route: discordRoute }));
  check('discord-stays-whole', discordSent.map(c => c.text), ['你好。今天天气不错！']);
  check('discord-no-forward', sent.length, 0);

  // ── 6. 控制类消息不套阈值（长文案仍整段普通发送） ──
  sent.length = 0;
  forwardCalls.length = 0;
  await bridge.sendReply(groupRoute, `❌ 执行失败：${'详细原因'.repeat(20)}`);
  check('control-message-not-forwarded', sent.map(c => c.kind), ['text']);
  check('control-message-no-forward-call', forwardCalls.length, 0);

  // ── 7. 流式逐句下发：完整句立即发出，未成形部分留在缓冲区 ──
  sent.length = 0;
  const streamRun = makeRun({ messageDelta: '你好。世界' });
  streamRun.pendingText = '你好。世界';
  await bridge.flushStreamUnits(streamRun);
  check('stream-flush-sent', sent.map(c => c.text), ['你好。']);
  check('stream-flush-rest', streamRun.pendingText, '世界');
  check('stream-flush-accounting', streamRun.sentTextLength, streamRun.messageDelta.length);

  // ── 8. [SKILL: / MEDIA: 绝不经流式下发 ──
  sent.length = 0;
  const skillRun = makeRun({ messageDelta: '好的。[SKILL:禁言 123 10]' });
  skillRun.pendingText = '好的。[SKILL:禁言 123 10]';
  await bridge.flushStreamUnits(skillRun);
  check('skill-label-not-streamed', sent.length, 0);
  check('skill-label-kept-in-buffer', skillRun.pendingText, '好的。[SKILL:禁言 123 10]');

  sent.length = 0;
  const mediaRun = makeRun({ messageDelta: '给你图。MEDIA:/tmp/a.png' });
  mediaRun.pendingText = '给你图。MEDIA:/tmp/a.png';
  await bridge.flushStreamUnits(mediaRun);
  check('media-label-not-streamed', sent.length, 0);

  // 含保留标签的文本不整体下发（交给 finishRun 处理技能标签/MEDIA）
  sent.length = 0;
  await bridge.sendAiReplyUnits(groupRoute, '好的。[SKILL:禁言 123 10]', 5, makeRun());
  check('label-text-not-sent-directly', sent.length, 0);

  // ── 9. finishRun 尾段：已逐句发完后不重复发送；残留尾段落回发送 ──
  sent.length = 0;
  bridge.appendHistory = () => {};
  bridge.sendReplyImage = async () => {};
  bridge.skillManager.processTags = async (text: string) => ({ text, images: [], feedback: [] });
  const doneRun = makeRun({ finalOutput: '你好。世界', messageDelta: '你好。世界', pendingText: '', sentTextLength: 9 });
  await bridge.finishRun(doneRun, () => {});
  check('no-duplicate-after-stream', sent.length, 0);

  sent.length = 0;
  const tailRun = makeRun({ finalOutput: '你好。世界', messageDelta: '你好。世界', pendingText: '世界', sentTextLength: 3 });
  await bridge.finishRun(tailRun, () => {});
  check('tail-is-sent-once', sent.map(c => c.text), ['世界']);

  // 运行失败且无流式增量时，仍要发出错误文案
  sent.length = 0;
  const failRun = makeRun({ finalOutput: '❌ 执行失败: 崩了', messageDelta: '', pendingText: '', sentTextLength: 0 });
  await bridge.finishRun(failRun, () => {});
  check('failed-output-still-sent', sent.map(c => c.text), ['❌ 执行失败: 崩了']);

  // 流式已下发过内容、随后 run.failed：失败文案仍必须发出（不被「已全部发送」吞掉）
  sent.length = 0;
  const failAfterStream = makeRun({
    finalOutput: '❌ 执行失败: 崩了',
    messageDelta: '你好。',
    pendingText: '',
    sentTextLength: 3,
    failed: true
  });
  await bridge.finishRun(failAfterStream, () => {});
  check('failed-after-stream-still-sent', sent.map(c => c.text), ['❌ 执行失败: 崩了']);

  // SSE 丢帧：run.completed 的完整输出比流式增量更长 → 补发差额，不重复不遗漏
  sent.length = 0;
  const lostFrame = makeRun({
    finalOutput: '你好。世界。再见。',
    messageDelta: '你好。世界。',
    pendingText: '',
    sentTextLength: 8
  });
  await bridge.finishRun(lostFrame, () => {});
  check('lost-frame-tail-recovered', sent.map(c => c.text), ['再见。']);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
