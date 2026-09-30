import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes Discord 侧：消息纯文本化 / 富文本格式化 / canChat 门控 / 路由匹配与管理员判定
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-discord-'));
process.chdir(tmp);

const BOT_ID = '8888';

function mockMessage(overrides: Record<string, unknown> = {}): any {
  const base: any = {
    content: '',
    author: { id: '111', username: 'gugle2308', bot: false },
    member: { displayName: 'Gugle' },
    guild: {
      name: 'AnvilCraft',
      ownerId: '999',
      roles: { cache: new Map([['500', { name: '管理组' }]]) },
      channels: { cache: new Map([['600', { name: 'general' }]]) }
    },
    mentions: {
      members: new Map([['222', { displayName: '古镇天' }]]),
      users: new Map(),
      has: (id: string) => id === BOT_ID
    },
    attachments: new Map(),
    stickers: { size: 0 },
    reference: null,
    channel: {
      messages: {
        fetch: async () => {
          throw new Error('not found');
        }
      }
    },
    webhookId: null,
    channelId: '1234',
    createdTimestamp: 1700000000000
  };
  return Object.assign(base, overrides);
}

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  // 注意：配置在 import 前一次性写好——运行中改写会触发 ConfigStore 的 fs.watch，
  // Windows 下 libuv 对相对路径 watcher 有断言崩溃（测试进程内无法安全热重载）
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'hermes.json'),
    JSON.stringify({ version: 1, groups: [659356928], forwardImages: true, admins: [2308465862] })
  );
  // mock fetch：图片下载返回固定字节（formatDiscordMessage 的多模态转换用）
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    headers: { get: () => 'image/png' }
  })) as any;

  const { HermesBridge } = await import('../src/features/hermes/index');
  const { isDiscordAdmin } = await import('../src/features/discord-bridge/source');
  const bridge = HermesBridge.getInstance() as any;

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  // ── plainDiscordText ──
  check(
    'plain-mention',
    bridge.plainDiscordText(mockMessage({ content: '<@222> 你好' }), BOT_ID),
    '@古镇天(222) 你好'
  );
  check('plain-bot-stripped', bridge.plainDiscordText(mockMessage({ content: `<@${BOT_ID}> 在吗` }), BOT_ID), '在吗');
  check(
    'plain-bot-nick-stripped',
    bridge.plainDiscordText(mockMessage({ content: `<@!${BOT_ID}> 在吗` }), BOT_ID),
    '在吗'
  );
  check('plain-role', bridge.plainDiscordText(mockMessage({ content: '<@&500> 注意' }), BOT_ID), '@管理组 注意');
  check('plain-channel', bridge.plainDiscordText(mockMessage({ content: '去 <#600> 聊' }), BOT_ID), '去 #general 聊');
  check('plain-emoji', bridge.plainDiscordText(mockMessage({ content: '好耶 <a:party:123>' }), BOT_ID), '好耶 :party:');

  // ── formatDiscordMessage（forwardImages=true + mock fetch） ──
  const withImage = mockMessage({
    content: '看这里',
    attachments: new Map([
      ['a1', { contentType: 'image/png', url: 'https://cdn.example.com/a.png', name: 'a.png' }],
      ['a2', { contentType: 'video/mp4', url: 'https://cdn.example.com/v.mp4', name: 'v.mp4' }]
    ])
  });
  check('format-attachments', await bridge.formatDiscordMessage(withImage, BOT_ID), {
    text: '看这里\n[图片]\n[附件 v.mp4]',
    images: ['data:image/png;base64,AQID']
  });

  // 回复引用：拉取成功 → 引用块（含发送者与内容）
  const replied = mockMessage({ content: '被引用的内容', author: { id: '333', username: 'other', bot: false } });
  const withRef = mockMessage({
    content: '引用回复',
    reference: { messageId: '777' },
    channel: { messages: { fetch: async () => replied } }
  });
  const refResult = await bridge.formatDiscordMessage(withRef, BOT_ID);
  check('format-reply-sender', refResult.text.includes('> Gugle(dc:333)'), true);
  check('format-reply-content', refResult.text.includes('> 被引用的内容'), true);

  // 回复引用：拉取失败 → 失败占位
  const refFail = await bridge.formatDiscordMessage(mockMessage({ content: 'x', reference: { messageId: '1' } }), BOT_ID);
  check('format-reply-fail', refFail.text.includes('> [引用消息获取失败]'), true);

  globalThis.fetch = originalFetch;

  // ── canChat：discord 路由只看桥接群是否启用 ──
  const dcRoute = { type: 'discord', groupId: '659356928', userId: 'dc:111', channelId: '1234' };
  const dcRouteOff = { type: 'discord', groupId: '123456789', userId: 'dc:111', channelId: '1234' };
  check('canChat-discord-enabled', bridge.canChat(dcRoute), true);
  check('canChat-discord-disabled', bridge.canChat(dcRouteOff), false);

  // ── routeMatches：QQ 群与互通 Discord 频道按群号对齐；私聊按人 ──
  const qqRoute = { type: 'group', groupId: '659356928', userId: '2308465862' };
  const userRoute = { type: 'user', userId: '2308465862' };
  check('match-qq-discord', bridge.routeMatches(qqRoute, dcRoute), true);
  check('match-discord-off', bridge.routeMatches(qqRoute, dcRouteOff), false);
  check('match-user', bridge.routeMatches(userRoute, { type: 'user', userId: '2308465862' }), true);
  check('match-user-vs-group', bridge.routeMatches(userRoute, qqRoute), false);

  // ── isRouteAdmin：QQ 取 hermes admins，Discord 取委托标记 ──
  check('admin-qq', bridge.isRouteAdmin(qqRoute), true);
  check('admin-qq-no', bridge.isRouteAdmin({ type: 'group', groupId: '659356928', userId: '1' }), false);
  check('admin-discord', bridge.isRouteAdmin({ ...dcRoute, discord: { isAdmin: true } }), true);
  check('admin-discord-no', bridge.isRouteAdmin({ ...dcRoute, discord: { isAdmin: false } }), false);

  // ── isDiscordAdmin（服务器拥有者 / 管理权限） ──
  check('dc-admin-owner', isDiscordAdmin(mockMessage({ author: { id: '999', username: 'owner', bot: false } })), true);
  check(
    'dc-admin-perm',
    isDiscordAdmin(mockMessage({ member: { displayName: 'G', permissions: { has: () => true } } })),
    true
  );
  check('dc-admin-no', isDiscordAdmin(mockMessage({ member: { displayName: 'G', permissions: { has: () => false } } })), false);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
