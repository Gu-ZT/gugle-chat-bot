import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 私聊「已收到」回执：贴表情成功则不打扰；NapCat 拒绝（私聊常见）时改发文字回执，
// 并在 AI 首条回复发出后撤回；群聊行为不受影响。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-receipt-'));
process.chdir(tmp);

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'hermes.json'),
    JSON.stringify({
      version: 1,
      apiUrl: 'http://127.0.0.1:9',
      groups: [1],
      admins: [],
      reactionEnabled: true,
      privateReactionFallbackText: true,
      privateReceiptText: '🤔 收到，正在思考…'
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

  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const makeBot = (opts: { emojiOk: boolean }) => {
    const calls: Array<{ url: string; body: any }> = [];
    const privates: string[] = [];
    return {
      calls,
      privates,
      bot: {
        logger,
        axiosInstance: {
          post: async (url: string, body: any) => {
            calls.push({ url, body });
            if (url.includes('set_msg_emoji_like') && !opts.emojiOk) throw new Error('400 Bad Request');
            return { data: { data: { message_id: 777 } } };
          }
        },
        getLoginInfoSync: () => ({ user_id: 999 }),
        sendPrivateMsg: async (_u: string, m: Array<{ data: { text?: string } }>) => {
          privates.push(m.map(s => s.data.text ?? '').join(''));
          return 777;
        },
        sendGroupMsg: async () => 1,
        sendGroupForwardMsg: async () => 1
      }
    };
  };

  const privateMsg = {
    post_type: 'message',
    message_type: 'private',
    self_id: 999,
    user_id: 100,
    message_id: 555,
    time: Math.floor(Date.now() / 1000),
    raw_message: '你好',
    font: 0,
    sub_type: 'friend',
    message_seq: 1,
    real_id: 555,
    real_seq: '1',
    sender: { user_id: 100, nickname: '测试', card: '' },
    target_id: 999,
    message: [{ type: 'text', data: { text: '你好' } }]
  };
  const groupMsg = {
    ...privateMsg,
    message_type: 'group',
    group_id: 1,
    group_name: 'g',
    sender: { user_id: 100, nickname: '测试', card: '', role: 'member' }
  };

  // ── A：私聊贴表情失败（NapCat 私聊常见）→ 发文字回执 ──
  const a = makeBot({ emojiOk: false });
  bridge.bot = a.bot;
  bridge.hermes.submitRun = async () => ({ runId: 'runA', status: 'running' });
  bridge.hermes.streamEvents = () => ({ abort() {} });
  await bridge.handleMessageSafe(a.bot, privateMsg);
  check('A-private-emoji-attempted', a.calls.some(c => c.url.includes('set_msg_emoji_like')), true);
  check('A-private-receipt-sent', a.privates, ['🤔 收到，正在思考…']);

  // ── B：私聊贴表情成功 → 不发文字回执（零噪音） ──
  const b = makeBot({ emojiOk: true });
  bridge.bot = b.bot;
  bridge.hermes.submitRun = async () => ({ runId: 'runB', status: 'running' });
  bridge.hermes.streamEvents = () => ({ abort() {} });
  await bridge.handleMessageSafe(b.bot, privateMsg);
  check('B-private-emoji-ok', b.calls.some(c => c.url.includes('set_msg_emoji_like')), true);
  check('B-private-no-text-receipt', b.privates, []);

  // ── C：群聊贴表情失败 → 不发文字回执（群聊不受影响） ──
  const c = makeBot({ emojiOk: false });
  bridge.bot = c.bot;
  bridge.hermes.submitRun = async () => ({ runId: 'runC', status: 'running' });
  bridge.hermes.streamEvents = () => ({ abort() {} });
  await bridge.handleMessageSafe(c.bot, groupMsg);
  check('C-group-no-text-receipt', c.privates, []);

  // ── D：AI 首条回复发出后撤回回执 ──
  const d = makeBot({ emojiOk: false });
  bridge.bot = d.bot;
  d.calls.length = 0;
  const run = {
    route: { type: 'user', userId: '100' },
    messageDelta: '',
    pendingText: '',
    sentTextLength: 0,
    userMsgId: 555,
    receiptId: 777,
    replySent: false
  };
  await bridge.sendReplyUnit({ type: 'user', userId: '100' }, { text: '你好呀', asForward: false }, 0, run);
  check('D-reply-sent', d.privates, ['你好呀']);
  check('D-receipt-recalled', d.calls.filter(x => x.url.includes('delete_msg')).map(x => x.body), [{ message_id: 777 }]);
  check('D-receipt-cleared', run.receiptId, undefined);

  // 只撤回一次
  d.calls.length = 0;
  await bridge.sendReplyUnit({ type: 'user', userId: '100' }, { text: '第二句', asForward: false }, 0, run);
  check('D-recall-once', d.calls.filter(x => x.url.includes('delete_msg')).length, 0);

  // ── E：撤回失败不阻塞回复 ──
  const e = makeBot({ emojiOk: false });
  e.bot.axiosInstance.post = async (url: string) => {
    if (url.includes('delete_msg')) throw new Error('msg not found');
    return { data: { data: {} } };
  };
  bridge.bot = e.bot;
  const runE = { route: { type: 'user', userId: '100' }, userMsgId: 5, receiptId: 888, replySent: false };
  await bridge.sendReplyUnit({ type: 'user', userId: '100' }, { text: '回复', asForward: false }, 0, runE);
  check('E-reply-still-sent', e.privates, ['回复']);

  // ── F：配置关闭回执 → 不发送 ──
  const { getHermesConfig } = await import('../src/features/hermes/config');
  const cfg = getHermesConfig();
  cfg.privateReactionFallbackText = false;
  const f = makeBot({ emojiOk: false });
  bridge.bot = f.bot;
  const fReceipt = await bridge.sendPrivateReceipt({ type: 'user', userId: '100' });
  check('F-disabled-no-receipt', [fReceipt, f.privates], [undefined, []]);
  cfg.privateReactionFallbackText = true;

  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main();
