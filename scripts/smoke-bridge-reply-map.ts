import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 回复链路由表：同一 QQ 消息在同群多个 Discord 频道各有转发，
// discordByQQ 必须按 bridge key 分别记录（此前互相覆盖导致 MESSAGE_REFERENCE_UNKNOWN）；
// sendWithReference 在被引用消息不可见时降级为无引用发送。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reply-map-'));
process.chdir(tmp);

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'discord-bridge.json'),
    JSON.stringify({
      version: 1,
      token: '',
      bridges: {
        '940551045929639949#general': { group: '659356928', need_reply: 'false', need_cmd: 'false' },
        '940551045929639949#中文': { group: '659356928', need_reply: 'false', need_cmd: 'false' }
      }
    })
  );

  const { DiscordBridge } = await import('../src/features/discord-bridge/index');
  const bridge = DiscordBridge.getInstance() as any;

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  // 同一 QQ 消息（id=42）转发到两个频道：两个 bridge key 的映射各自独立
  bridge.registerDiscordMessage('9000000000000000001', 42, '940551045929639949#general');
  bridge.registerDiscordMessage('9000000000000000002', 42, '940551045929639949#中文');
  check('qq→dc per-bridge', bridge.discordByQQ.get(42), {
    '940551045929639949#general': '9000000000000000001',
    '940551045929639949#中文': '9000000000000000002'
  });

  // Discord→QQ 方向同样按 bridge key 记录（id=43）
  bridge.registerQQMessage(43, '9000000000000000003', '940551045929639949#general');
  bridge.registerQQMessage(43, '9000000000000000004', '940551045929639949#中文');
  check('dc→qq per-bridge', bridge.discordByQQ.get(43), {
    '940551045929639949#general': '9000000000000000003',
    '940551045929639949#中文': '9000000000000000004'
  });

  // 反向映射与桥消息标记仍然正确
  check(
    'qqByDiscord',
    [bridge.qqByDiscord.get(bridge.snowflakeToKey('9000000000000000001')), bridge.qqByDiscord.get(bridge.snowflakeToKey('9000000000000000003'))],
    [42, 43]
  );
  check('dcFromBridge', bridge.dcFromBridge.get(bridge.snowflakeToKey('9000000000000000001')), true);
  check('qqFromBridge', bridge.qqFromBridge.get(43), true);

  // sendWithReference：引用不可见 → 降级为无引用重发
  const calls: any[] = [];
  const flakyChannel = {
    send: async (payload: any) => {
      calls.push(payload);
      if (payload.reply) throw new Error('Invalid Form Body\nmessage_reference[MESSAGE_REFERENCE_UNKNOWN_MESSAGE]: Unknown message');
      return { id: 'sent-1' };
    }
  };
  const recovered = await bridge.sendWithReference(flakyChannel, { content: 'hi', files: [] }, '9000000000000000001');
  check('fallback-retried', calls.length, 2);
  check('fallback-first-with-reply', Boolean(calls[0].reply), true);
  check('fallback-second-no-reply', calls[1].reply === undefined, true);
  check('fallback-result', recovered.id, 'sent-1');

  // 无引用时直接发送，不重试
  calls.length = 0;
  await bridge.sendWithReference(flakyChannel, { content: 'hi', files: [] }, undefined);
  check('no-reference-single-call', calls.length, 1);

  // 非引用类错误不重试，原样抛出
  const fatalChannel = {
    send: async () => {
      throw new Error('Missing Permissions');
    }
  };
  let propagated = false;
  try {
    await bridge.sendWithReference(fatalChannel, { content: 'hi', files: [] }, '9000000000000000001');
  } catch (error) {
    propagated = (error as Error).message === 'Missing Permissions';
  }
  check('other-error-propagates', propagated, true);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
