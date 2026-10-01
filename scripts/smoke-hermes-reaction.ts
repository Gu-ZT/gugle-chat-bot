import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes「处理中」表情回应：
// - ReactionManager：贴/摘表情立即持久化 data/hermes-reactions.json，
//   失败不阻塞、cleanupQQ 只清理 QQ 残留、重启后可从磁盘恢复记录；
// - handleRunComplete：正常/空输出/已全部发送结束都摘除表情；
//   查询技能回喂轮把记录键转移给下一轮（不摘除）；
// - Discord 路由经委托摘除并 drop 持久化记录。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-reaction-'));
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
  const { ReactionManager } = await import('../src/features/hermes/reaction');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  };

  const storeFile = path.join(tmp, 'data', 'hermes-reactions.json');
  const readStore = (): Array<{ key: string; platform: string }> => {
    if (!fs.existsSync(storeFile)) return [];
    return (JSON.parse(fs.readFileSync(storeFile, 'utf-8')) as { reactions: Array<{ key: string; platform: string }> })
      .reactions;
  };

  // ── ReactionManager：QQ 贴/摘 + 持久化 ──
  const rm = ReactionManager.getInstance();
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeBot = {
    axiosInstance: {
      post: async (url: string, body: Record<string, unknown>) => {
        posts.push({ url, body });
        return { data: { data: {} } };
      }
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  } as never;

  const key = await rm.addQQ(fakeBot, 123);
  check('add-qq-key', key, 'qq:123');
  check('add-qq-post', posts[0]?.body, { message_id: 123, emoji_id: '76', set: true });
  check('add-qq-persisted', readStore().map(r => r.key), ['qq:123']);

  await rm.removeQQ(fakeBot, 'qq:123');
  check('remove-qq-post', posts[1]?.body, { message_id: 123, emoji_id: '76', set: false });
  check('remove-qq-persist-cleared', readStore(), []);

  // 贴表情失败：返回 null 且不落记录
  const failBot = {
    axiosInstance: { post: async () => Promise.reject(new Error('msg not found')) },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  } as never;
  check('add-qq-fail-null', await rm.addQQ(failBot, 456), null);
  check('add-qq-fail-no-record', readStore(), []);

  // 摘除失败也移除记录（不可重试场景不留残留）
  await rm.addQQ(fakeBot, 789);
  await rm.removeQQ(failBot, 'qq:789');
  check('remove-qq-fail-still-dropped', readStore(), []);

  // ── ReactionManager：Discord 记录与启动清理 ──
  const dcKey = rm.persistDiscord('9001', '8001', '👀');
  check('persist-discord-key', dcKey, 'discord:9001:8001');
  check('list-discord', rm.listDiscord().map(r => r.key), ['discord:9001:8001']);

  await rm.addQQ(fakeBot, 321);
  posts.length = 0;
  await rm.cleanupQQ(fakeBot);
  check('cleanup-qq-post', posts[0]?.body, { message_id: 321, emoji_id: '76', set: false });
  check('cleanup-qq-keeps-discord', readStore().map(r => r.key), ['discord:9001:8001']);
  rm.drop('discord:9001:8001');
  check('drop-discord', readStore(), []);

  // 重启恢复：磁盘上的记录在重新加载后可见（模拟进程重启后清理）
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(
    storeFile,
    JSON.stringify({
      version: 1,
      reactions: [
        { key: 'qq:555', platform: 'qq', messageId: '555', emoji: '76', createdAt: 1 },
        { key: 'discord:9002:8002', platform: 'discord', messageId: '8002', channelId: '9002', emoji: '👀', createdAt: 2 }
      ]
    })
  );
  (rm as unknown as { loaded: boolean }).loaded = false;
  (rm as unknown as { records: Map<string, unknown> }).records.clear();
  check('reload-from-disk-qq-cleaned', await (async () => {
    posts.length = 0;
    await rm.cleanupQQ(fakeBot);
    return posts[0]?.body ?? null;
  })(), { message_id: 555, emoji_id: '76', set: false });
  check('reload-from-disk-discord-left', rm.listDiscord().map(r => r.key), ['discord:9002:8002']);
  rm.drop('discord:9002:8002');

  // ── handleRunComplete：表情摘除时机 ──
  const bridge = HermesBridge.getInstance() as any;
  bridge.bot = { logger: { info() {}, warn() {}, error() {}, debug() {} } };

  const removedKeys: string[] = [];
  const discordRemoved: string[] = [];
  bridge.reactions = {
    addQQ: async () => null,
    removeQQ: async (_bot: unknown, k: string) => {
      removedKeys.push(k);
    },
    drop: (k: string) => {
      removedKeys.push(k);
    },
    persistDiscord: () => '',
    listDiscord: () => [],
    cleanupQQ: async () => {}
  };
  const sentTexts: string[] = [];
  bridge.sendReplyImage = async () => {};
  bridge.sendReplyWithMention = async (_route: unknown, text: string) => {
    sentTexts.push(text);
  };
  bridge.sendReply = async () => {};
  bridge.appendHistory = () => {};
  const followups: Array<{ depth: number; reactionKey?: string }> = [];
  bridge.startHermesRun = async (
    _bot: unknown,
    _route: unknown,
    _text: string,
    _images: unknown,
    _senderLabel: unknown,
    _replyMsgId: unknown,
    depth = 0,
    reactionKey?: string
  ) => {
    followups.push(reactionKey !== undefined ? { depth, reactionKey } : { depth });
  };

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

  const route = { type: 'group', groupId: '1', userId: '100' };
  const makeRun = (runId: string, finalOutput: string, feedbackDepth: number, extra: Record<string, unknown> = {}) =>
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
      feedbackDepth,
      ...extra
    });

  // A：正常完成 → 摘除表情
  makeRun('runA', '你好呀', 0, { reactionKey: 'qq:1001' });
  await bridge.handleRunComplete('runA');
  check('complete-removes-reaction', removedKeys, ['qq:1001']);
  check('complete-sent', sentTexts, ['你好呀']);

  // B：回喂轮 → 不摘除，记录键转移给下一轮
  removedKeys.length = 0;
  sentTexts.length = 0;
  followups.length = 0;
  makeRun('runB', '我查一下 [SKILL:查天气]', 0, { reactionKey: 'qq:1002' });
  await bridge.handleRunComplete('runB');
  check('feedback-keeps-reaction', removedKeys, []);
  check('feedback-transfers-key', followups, [{ depth: 1, reactionKey: 'qq:1002' }]);

  // B2：回喂链尾（无标签）→ 摘除
  makeRun('runB2', '今天晴，25 度', 1, { reactionKey: 'qq:1002' });
  await bridge.handleRunComplete('runB2');
  check('feedback-tail-removes', removedKeys, ['qq:1002']);

  // C：空输出（失败通知）→ 摘除
  removedKeys.length = 0;
  sentTexts.length = 0;
  makeRun('runC', '', 0, { reactionKey: 'qq:1003' });
  await bridge.handleRunComplete('runC');
  check('empty-output-removes', removedKeys, ['qq:1003']);

  // D：流式已全部发送的提前返回 → 摘除
  removedKeys.length = 0;
  bridge.activeRuns.set('runD', {
    route,
    tools: [],
    currentTool: null,
    startedAt: Date.now(),
    lastProgressSent: 0,
    sendingProgress: false,
    messageDelta: '已发的内容',
    pendingText: '',
    sentTextLength: 5,
    lastTextSent: 0,
    finalOutput: '已发的内容',
    userMsgId: 5,
    senderLabel: '张三 (100)',
    feedbackDepth: 0,
    reactionKey: 'qq:1004'
  });
  await bridge.handleRunComplete('runD');
  check('all-sent-removes', removedKeys, ['qq:1004']);

  // E：Discord 路由 → 经委托摘除并 drop 记录
  removedKeys.length = 0;
  const dcRoute = {
    type: 'discord',
    groupId: '1',
    userId: 'dc:42',
    channelId: '9001',
    discord: {
      guildName: 'g',
      channelName: 'c',
      isAdmin: false,
      send: async () => {},
      sendImage: async () => {},
      removeReaction: async () => {
        discordRemoved.push('removed');
      }
    }
  };
  bridge.activeRuns.set('runE', {
    route: dcRoute,
    tools: [],
    currentTool: null,
    startedAt: Date.now(),
    lastProgressSent: 0,
    sendingProgress: false,
    messageDelta: '',
    pendingText: '',
    sentTextLength: 0,
    lastTextSent: 0,
    finalOutput: 'discord 回复',
    userMsgId: 0,
    senderLabel: 'Akari (dc:42)',
    feedbackDepth: 0,
    reactionKey: 'discord:9001:8001'
  });
  await bridge.handleRunComplete('runE');
  check('discord-delegate-remove', discordRemoved, ['removed']);
  check('discord-drop-record', removedKeys, ['discord:9001:8001']);

  // F：无表情记录键的 run 不受影响
  removedKeys.length = 0;
  sentTexts.length = 0;
  makeRun('runF', '无表情', 0);
  await bridge.handleRunComplete('runF');
  check('no-key-no-remove', removedKeys, []);
  check('no-key-sent', sentTexts, ['无表情']);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
