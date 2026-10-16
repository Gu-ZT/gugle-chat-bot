import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 消息解析（stub resolver，不联网）：引用/聊天记录展开、深度表、
// 图片收集与占位、@提及回退、失败占位、visitedIds 自环护栏
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-message-'));
process.chdir(tmp);

const IMAGE_A = 'data:image/png;base64,AAA';
const IMAGE_B = 'data:image/png;base64,BBB';

/** 图片段（url 用于 stub 侧判定，不触网） */
const image = (url: string) => ({ type: 'image', data: { file: url, url } });
const text = (value: string) => ({ type: 'text', data: { text: value } });

async function main() {
  const { FORWARD_PLACEHOLDER, parseMessage, parseSegments, createParseState } = await import(
    '../src/features/hermes/message'
  );

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  const getMsgCalls: number[] = [];
  const getForwardCalls: string[] = [];
  const imageCalls: string[] = [];
  const nameCalls: string[] = [];
  const messages = new Map<number, unknown>();
  const forwards = new Map<string, unknown>();

  const stub = {
    getMsg: async (messageId: number) => {
      getMsgCalls.push(messageId);
      const found = messages.get(messageId);
      if (!found) throw new Error(`get_msg 失败: ${messageId}`);
      return found as { sender?: { nickname?: string; user_id?: number }; time?: number; message: unknown };
    },
    getForward: async (forwardId: string) => {
      getForwardCalls.push(forwardId);
      const found = forwards.get(forwardId);
      if (!found) throw new Error(`get_forward_msg 失败: ${forwardId}`);
      return { messages: found as unknown[] };
    },
    resolveImage: async (segment: { data: { file: string; url?: string } }) => {
      imageCalls.push(segment.data.url ?? segment.data.file);
      // 只有 a.png 能解析成功：其余返回 null，用于断言「失败仍保留 [图片] 占位」
      return segment.data.url === 'a.png' ? IMAGE_A : null;
    },
    resolveName: async (qq: string) => {
      nameCalls.push(qq);
      return qq === '111' ? '小明' : null;
    },
    formatTime: (unixTs: number) => `T${unixTs}`,
    forwardImages: true
  };
  const noImages = { ...stub, forwardImages: false };
  const noNames = { ...stub, resolveName: undefined };

  // ── 顶层非数组输入 ──
  check('string-input', await parseMessage('原样文本', 100, stub), { text: '原样文本', images: [] });
  check('undefined-input', await parseMessage(undefined, 100, stub), { text: '', images: [] });
  check('number-input', await parseMessage(42, 100, stub), { text: '', images: [] });

  // ── 基础段 ──
  check(
    'text-at-image',
    await parseMessage([text('你好'), { type: 'at', data: { qq: 111 } }, image('a.png')], 100, stub),
    { text: '你好@小明[图片]', images: [IMAGE_A] }
  );
  check(
    'at-all',
    await parseMessage([{ type: 'at', data: { qq: 'all' } }, text('注意')], 100, stub),
    { text: '@全体成员注意', images: [] }
  );
  check(
    'at-fallback-qq',
    await parseMessage([{ type: 'at', data: { qq: 222 } }], 100, stub),
    { text: '@222', images: [] }
  );
  // 私聊（groupId 缺失）不查昵称，直接回退 QQ 号
  nameCalls.length = 0;
  check('at-private', await parseMessage([{ type: 'at', data: { qq: 111 } }], undefined, stub), {
    text: '@111',
    images: []
  });
  check('at-private-no-query', nameCalls, []);
  check('at-no-resolver', await parseMessage([{ type: 'at', data: { qq: 111 } }], 100, noNames), {
    text: '@111',
    images: []
  });
  check(
    'video-record',
    await parseMessage([{ type: 'video', data: {} }, { type: 'record', data: {} }, { type: 'face', data: { id: 1 } }], 100, stub),
    { text: '[视频][语音]', images: [] }
  );
  // forwardImages=false → 仍保留 [图片] 占位，但不下载
  imageCalls.length = 0;
  check('image-off', await parseMessage([image('a.png')], 100, noImages), { text: '[图片]', images: [] });
  check('image-off-no-call', imageCalls, []);
  // resolveImage 返回 null → 保留占位不抛错
  check('image-null', await parseMessage([image('unknown.png')], 100, stub), { text: '[图片]', images: [] });

  // ── 引用（reply，depth 0 → 内容 depth 1） ──
  getMsgCalls.length = 0;
  messages.set(1, { sender: { nickname: '小红', user_id: 222 }, time: 1000, message: [text('被引用的内容'), image('a.png')] });
  check('reply-with-image', await parseMessage([{ type: 'reply', data: { id: 1 } }, text('我的回复')], 100, stub), {
    text: '> 小红(222) T1000\n> 被引用的内容[图片]\n我的回复',
    images: [IMAGE_A]
  });
  check('reply-get-msg-id', getMsgCalls, [1]);
  // 引用获取失败 → 占位符（parseSegments 每层 trim，故顶层无尾随换行）
  check('reply-fail', await parseMessage([{ type: 'reply', data: { id: 999 } }], 100, stub), {
    text: '> [引用消息获取失败]',
    images: []
  });
  // 引用内容里的 @提及 同样解析（同一次解析共享昵称缓存）
  messages.set(2, { sender: { nickname: '小红', user_id: 222 }, time: 2000, message: [{ type: 'at', data: { qq: 111 } }] });
  check('reply-at', await parseMessage([{ type: 'reply', data: { id: 2 } }], 100, stub), {
    text: '> 小红(222) T2000\n> @小明',
    images: []
  });

  // ── 聊天记录（forward，depth 0 → 节点 depth 1：逐节点文字 + 节点内图片入 images） ──
  getForwardCalls.length = 0;
  forwards.set('fwd1', [
    { type: 'node', data: { user_id: 111, nickname: '小明', time: 3000, message: [text('节点一'), image('a.png')] } },
    { type: 'node', data: { user_id: 222, nickname: '小红', card: '小红花', time: 4000, content: '节点二（字符串）' } }
  ]);
  check('forward-nodes', await parseMessage([{ type: 'forward', data: { id: 'fwd1' } }], 100, stub), {
    text: '> 小明(111) T3000\n> 节点一[图片]\n> 小红(222) T4000\n> 节点二（字符串）',
    images: [IMAGE_A]
  });
  check('forward-get-id', getForwardCalls, ['fwd1']);
  // NapCat 与 go-cqhttp 旧格式混排
  forwards.set('fwd2', [
    { type: 'node', data: { user_id: 333, nickname: '纳普猫', card: '群名片', time: 5000, message: [text('新格式')] } },
    { sender: { user_id: 444, nickname: '老格式' }, time: 6000, content: [text('旧格式')] },
    { sender: { user_id: 555, nickname: '无时间' }, content: '旧格式字符串' }
  ]);
  check('forward-legacy', await parseMessage([{ type: 'forward', data: { id: 'fwd2' } }], 100, stub), {
    text: '> 纳普猫(333) T5000\n> 新格式\n> 老格式(444) T6000\n> 旧格式\n> 无时间(555)\n> 旧格式字符串',
    images: []
  });
  // 转发获取失败 → 占位符
  check('forward-fail', await parseMessage([{ type: 'forward', data: { id: 'missing' } }], 100, stub), {
    text: '> [转发消息获取失败]',
    images: []
  });

  // ── 深度表：depth 1 的 forward（引用内容里的聊天记录）只展开文字，节点图片在 depth 2 不下载 ──
  messages.set(3, {
    sender: { nickname: '小红', user_id: 222 },
    time: 7000,
    message: [text('看看这个'), { type: 'forward', data: { id: 'fwd1' } }]
  });
  check('reply-then-forward', await parseMessage([{ type: 'reply', data: { id: 3 } }], 100, stub), {
    text:
      '> 小红(222) T7000\n> 看看这个> 小明(111) T3000\n> 节点一[图片]\n> 小红(222) T4000\n> 节点二（字符串）',
    images: []
  });
  // depth 2 的嵌套（引用 → 引用）只回文字、图片不下载
  messages.set(4, { sender: { nickname: '甲', user_id: 666 }, time: 8000, message: [text('二层'), image('a.png')] });
  messages.set(5, {
    sender: { nickname: '乙', user_id: 777 },
    time: 9000,
    message: [{ type: 'reply', data: { id: 4 } }, text('一层')]
  });
  check('nested-depth2', await parseMessage([{ type: 'reply', data: { id: 5 } }], 100, stub), {
    text: '> 乙(777) T9000\n> > 甲(666) T8000\n> 二层[图片]\n一层',
    images: []
  });
  // depth ≥3：不拉取，恰好输出 [聊天记录]
  // 引用链 6 → 15 → 14，内容分别落在 depth 1/2/3；14 内部的 reply 段处于 depth 3 → 不拉取 20
  messages.set(20, { sender: { nickname: '深层', user_id: 555 }, time: 12000, message: [text('不该被拉取')] });
  messages.set(14, {
    sender: { nickname: '甲', user_id: 666 },
    time: 8000,
    message: [text('二层'), image('a.png'), { type: 'reply', data: { id: 20 } }]
  });
  messages.set(15, { sender: { nickname: '乙', user_id: 777 }, time: 9000, message: [{ type: 'reply', data: { id: 14 } }] });
  getMsgCalls.length = 0;
  messages.set(6, { sender: { nickname: '丙', user_id: 888 }, time: 10000, message: [{ type: 'reply', data: { id: 15 } }] });
  check('depth3-forward', await parseMessage([{ type: 'reply', data: { id: 6 } }], 100, stub), {
    // 嵌套引用块沿用既有格式：只有嵌套内容的首行多一层 `> `，后续行保留自身前缀
    text:
      `> 丙(888) T10000\n> > 乙(777) T9000\n> > 甲(666) T8000\n` +
      `> 二层[图片]${FORWARD_PLACEHOLDER}`,
    images: []
  });
  check('depth3-no-fetch', getMsgCalls, [6, 15, 14]);
  // forward 在 depth ≥3 同样只留占位（且不再调用 get_forward_msg）
  // fwd3 的节点在 depth 1，其内的 fwd1 落到 depth 2（仍会拉取，但节点图片不下载）
  getForwardCalls.length = 0;
  forwards.set('fwd3', [{ type: 'node', data: { user_id: 111, nickname: '小明', message: [{ type: 'forward', data: { id: 'fwd1' } }] } }]);
  check('depth2-forward-segment', await parseMessage([{ type: 'forward', data: { id: 'fwd3' } }], 100, stub), {
    text: '> 小明(111)\n> > 小明(111) T3000\n> 节点一[图片]\n> 小红(222) T4000\n> 节点二（字符串）',
    images: []
  });
  check('depth2-forward-calls', getForwardCalls, ['fwd3', 'fwd1']);
  // depth ≥3 的 forward：不拉取，只留 [聊天记录]
  // 转发链 fwd5 → fwd6 → fwd8，节点内容分别落在 depth 1/2/3；fwd8 节点内的 forward 处于 depth 3 → 不拉取 fwd9
  forwards.set('fwd9', [{ type: 'node', data: { user_id: 111, nickname: '小明', message: [text('不该被拉取')] } }]);
  forwards.set('fwd8', [{ type: 'node', data: { user_id: 111, nickname: '小明', message: [{ type: 'forward', data: { id: 'fwd9' } }] } }]);
  forwards.set('fwd6', [{ type: 'node', data: { user_id: 111, nickname: '小明', message: [{ type: 'forward', data: { id: 'fwd8' } }] } }]);
  forwards.set('fwd5', [{ type: 'node', data: { user_id: 111, nickname: '小明', message: [{ type: 'forward', data: { id: 'fwd6' } }] } }]);
  getForwardCalls.length = 0;
  check('depth3-forward-segment', await parseMessage([{ type: 'forward', data: { id: 'fwd5' } }], 100, stub), {
    text: `> 小明(111)\n> > 小明(111)\n> > 小明(111)\n> ${FORWARD_PLACEHOLDER}`,
    images: []
  });
  check('depth3-forward-calls', getForwardCalls, ['fwd5', 'fwd6', 'fwd8']);

  // ── 护栏：visitedIds 自环 / 互环不死循环 ──
  // 已访问过的 id 不再展开，统一留 [聊天记录] 占位（含自环）
  messages.set(7, { sender: { nickname: '自环', user_id: 999 }, time: 11000, message: [{ type: 'reply', data: { id: 7 } }] });
  const selfLoop = await parseMessage([{ type: 'reply', data: { id: 7 } }], 100, stub);
  check('self-loop', selfLoop, { text: `> 自环(999) T11000\n> ${FORWARD_PLACEHOLDER}`, images: [] });
  // 互环：8 → 9 → 8，第二次遇到 8 时阻断，不会无限下拉
  messages.set(8, { sender: { nickname: '甲', user_id: 1 }, time: 1, message: [{ type: 'reply', data: { id: 9 } }] });
  messages.set(9, { sender: { nickname: '乙', user_id: 2 }, time: 2, message: [{ type: 'reply', data: { id: 8 } }] });
  const mutualLoop = await parseMessage([{ type: 'reply', data: { id: 8 } }], 100, stub);
  check('mutual-loop-no-hang', mutualLoop.text.includes('[引用消息获取失败]'), false);
  check('mutual-loop-text', mutualLoop.text, `> 甲(1) T1\n> > 乙(2) T2\n> ${FORWARD_PLACEHOLDER}`);
  // 同一 id 在一条消息里重复出现：只展开一次，第二次留占位
  const repeat = await parseMessage(
    [{ type: 'reply', data: { id: 1 } }, { type: 'reply', data: { id: 1 } }],
    100,
    stub
  );
  check('repeat-id', repeat.text, `> 小红(222) T1000\n> 被引用的内容[图片]\n${FORWARD_PLACEHOLDER}`);
  check('repeat-id-images', repeat.images, [IMAGE_A]);

  // ── 护栏：段/节点/图片上限 ──
  const manySegments = Array.from({ length: 600 }, (_, index) => text(`${index % 10}`));
  const capped = await parseMessage(manySegments, 100, stub);
  check('segment-cap', capped.text.length, 500);
  const manyNodes = Array.from({ length: 60 }, (_, index) => ({
    type: 'node',
    data: { user_id: index, nickname: `n${index}`, message: [text('x')] }
  }));
  forwards.set('fwd-many', manyNodes);
  const cappedNodes = await parseMessage([{ type: 'forward', data: { id: 'fwd-many' } }], 100, stub);
  // 每个节点渲染为 `> 昵称(id)\n> x`（2 行），50 个节点 → 100 行
  check('node-cap', cappedNodes.text.split('\n').length, 100);
  const manyImages = Array.from({ length: 12 }, () => image('a.png'));
  const cappedImages = await parseMessage(manyImages, 100, stub);
  check('image-cap', cappedImages.images.length, 10);
  check('image-cap-placeholder', cappedImages.text, '[图片]'.repeat(12));

  // ── parseSegments 直接调用（无 state 时自建，昵称解析开启） ──
  const directImages: string[] = [];
  check(
    'parse-segments-string',
    await parseSegments('字符串段', 0, stub, directImages),
    '字符串段'
  );
  check(
    'parse-segments-array',
    await parseSegments([text('甲'), { type: 'at', data: { qq: 111 } }], 0, stub, directImages),
    '甲@小明'
  );
  check('parse-segments-images', directImages, []);
  check('parse-segments-invalid', await parseSegments(undefined, 0, stub, []), '');
  // 显式传入 state：跨调用累计已展开的 id，重复展开被拦下
  const state = createParseState(true);
  const sharedImages: string[] = [];
  const first = await parseSegments([{ type: 'reply', data: { id: 1 } }], 0, stub, sharedImages, state);
  const second = await parseSegments([{ type: 'reply', data: { id: 1 } }], 0, stub, sharedImages, state);
  check('state-shared-first', first, '> 小红(222) T1000\n> 被引用的内容[图片]');
  check('state-shared-second', second, FORWARD_PLACEHOLDER);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
