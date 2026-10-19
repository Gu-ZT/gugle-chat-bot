import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 分条消息顺序（回归测试）：message.delta 的逐句下发是 fire-and-forget，
// 若按条入队或并发 await，后一批会插到前一批未发完的句子之前，出现
// 「一一得一 / 尾句 / 一二得二 / 一三得三」错序。此处锁死正确顺序与不丢字。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-send-order-'));
process.chdir(tmp);

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'hermes.json'),
    // 本脚本只关心顺序：显式固定阈值，避免默认值调整或长句被折进聊天记录干扰断言
    JSON.stringify({
      version: 1,
      apiUrl: 'http://127.0.0.1:9',
      groups: [1],
      replyPerSentence: true,
      compactMaxChars: 0,
      compactMaxLines: 0
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

  /** 每次发送耗时 sendDelayMs，模拟真实 HTTP + QQBot.operation 队列的慢发送 */
  const makeHarness = (sendDelayMs: number) => {
    const sent: string[] = [];
    const bot = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      getLoginInfoSync: () => ({ user_id: 10000 }),
      sendGroupMsg: async (_g: string, m: Array<{ type: string; data: { text?: string } }>) => {
        const text = m.filter(s => s.type === 'text').map(s => s.data.text ?? '').join('');
        await new Promise(r => setTimeout(r, sendDelayMs));
        sent.push(text);
        return sent.length;
      },
      sendGroupForwardMsg: async (_g: string, nodes: Array<{ content: string }>) => {
        await new Promise(r => setTimeout(r, sendDelayMs));
        sent.push(nodes.map(n => n.content).join(''));
        return sent.length;
      },
      sendPrivateMsg: async () => 1,
      axiosInstance: { post: async () => ({ data: { data: {} } }) }
    };
    bridge.bot = bot;
    bridge.appendHistory = () => {};
    bridge.sendReplyImage = async () => {};
    bridge.skillManager.processTags = async (text: string) => ({ text, images: [], feedback: [] });
    const run: any = {
      route: { type: 'group', groupId: '1', userId: '100' },
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
      replySent: false
    };
    return { sent, run };
  };

  // ── 1. 截图场景：一次 delta 连吐多句 + 下一 delta 紧跟着到达 ──
  {
    const { sent, run } = makeHarness(60);
    const burst = '一一得一。一二得二。一三得三。';
    run.messageDelta += burst;
    run.pendingText += burst;
    void bridge.flushStreamUnits(run).catch(() => {}); // 与 message.delta 一致：不 await
    await new Promise(r => setTimeout(r, 20)); // 发送仍在途
    const tail = '剩下的想听哪天私聊报数，不然泡点茶该说这群从算卦群变成背诵群了。';
    run.messageDelta += tail;
    run.pendingText += tail;
    void bridge.flushStreamUnits(run).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
    check('burst-then-tail-order', sent, ['一一得一。', '一二得二。', '一三得三。', tail]);
  }

  // ── 2. 逐句流式（每句一个 delta，发送慢于 delta）→ 严格按序且不丢 ──
  {
    const { sent, run } = makeHarness(40);
    const sentences = ['第一句。', '第二句。', '第三句。', '第四句。'];
    for (const s of sentences) {
      run.messageDelta += s;
      run.pendingText += s;
      void bridge.flushStreamUnits(run).catch(() => {});
      await new Promise(r => setTimeout(r, 10)); // delta 间隔 < 发送耗时
    }
    await bridge.finishRun(run, () => {});
    await new Promise(r => setTimeout(r, 400));
    check('stream-order', sent, sentences);
    check('stream-no-duplicate', sent.length, sentences.length);
  }

  // ── 3. 未发完的单元 + 收尾尾段：尾段必须排在最后（不插队、不重复） ──
  {
    const { sent, run } = makeHarness(50);
    run.messageDelta = '甲。乙。丙';
    run.pendingText = '甲。乙。丙';
    void bridge.flushStreamUnits(run).catch(() => {}); // 发「甲。乙。」，留「丙」
    await new Promise(r => setTimeout(r, 5)); // 仍在途
    run.finalOutput = '甲。乙。丙';
    await bridge.finishRun(run, () => {}); // 尾段「丙」必须最后发
    await new Promise(r => setTimeout(r, 500));
    check('tail-after-units', sent, ['甲。', '乙。', '丙']);
  }

  // ── 4. 工具边界强制 flush 与后续 delta：整体仍按序 ──
  {
    const { sent, run } = makeHarness(30);
    run.messageDelta = '工具前。';
    run.pendingText = '工具前。';
    await bridge.sendReplyUnits(
      run.route,
      (await import('../src/features/hermes/reply-units')).splitReplyIntoUnits(run.pendingText, {
        maxUnitLength: 1200,
        compactMaxChars: 40,
        compactMaxLines: 5
      }),
      run.userMsgId,
      run
    );
    run.pendingText = '';
    run.messageDelta += '工具后。';
    run.pendingText += '工具后。';
    void bridge.flushStreamUnits(run).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    check('tool-boundary-order', sent, ['工具前。', '工具后。']);
  }

  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main();
