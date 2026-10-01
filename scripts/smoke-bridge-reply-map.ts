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
    id: 'ch-1',
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

  // ── 机器人消息门控：与普通 QQ 消息同一套语义 ──
  // 未门控频道全放行；need_cmd/need_reply 频道仅放行「对该频道桥消息的回复」；webhook 一律不进
  const entryOf = (needReply: string, needCmd: string) => ({
    key: '940551045929639949#x',
    guildId: '940551045929639949',
    channelName: 'x',
    entry: { group: '659356928', need_reply: needReply, need_cmd: needCmd }
  });
  check('webhook-skip-need_cmd', bridge.shouldForwardBotMessage(entryOf('false', 'true'), true), false);
  check('webhook-skip-need_reply', bridge.shouldForwardBotMessage(entryOf('true', 'false'), true), false);
  check('webhook-skip-both', bridge.shouldForwardBotMessage(entryOf('true', 'true'), true), false);
  check('webhook-allow-open', bridge.shouldForwardBotMessage(entryOf('false', 'false'), true), true);
  // 交互式消息（AI 回复、#编号卡片、命令回复）：无回复上下文时不进门控频道
  check('interactive-skip-need_cmd', bridge.shouldForwardBotMessage(entryOf('false', 'true'), false), false);
  check('interactive-skip-need_reply', bridge.shouldForwardBotMessage(entryOf('true', 'false'), false), false);
  check('interactive-allow-open', bridge.shouldForwardBotMessage(entryOf('false', 'false'), false), true);
  // 回复本频道桥消息 → 放行（如 AI 回复 /send 到 QQ 的消息）
  check('interactive-reply-own-bridge', bridge.shouldForwardBotMessage(entryOf('false', 'true'), false, '940551045929639949#x'), true);
  // 回复的是别的频道的桥消息 → 仍不进本频道（回复要回到原频道）
  check('interactive-reply-other-bridge', bridge.shouldForwardBotMessage(entryOf('false', 'true'), false, '940551045929639949#other'), false);
  // webhook 推送即使带回复上下文也不进门控频道
  check('webhook-reply-still-skip', bridge.shouldForwardBotMessage(entryOf('false', 'true'), true, '940551045929639949#x'), false);

  // ── 机器人自己的 Discord 消息 → QQ：桥转发跳过（防回环），其余按门控同步 ──
  const sentToQQ: { id: string; bridge: string; referenceId: string | null }[] = [];
  bridge.forwardDiscordToQQ = async (message: any, target: any, referenceId?: string | null) => {
    sentToQQ.push({ id: message.id, bridge: target.key, referenceId: referenceId ?? null });
  };
  const ownMessage = (id: string, content: string, referenceId?: string) => ({
    id,
    channelId: 'ch-1',
    content,
    attachments: { size: 0 },
    reference: referenceId ? { messageId: referenceId } : null
  });
  // 桥自身 QQ→Discord 的转发（id=9000000000000000001 已登记 dcFromBridge）→ 跳过防回环
  await bridge.handleOwnDiscordMessage(ownMessage('9000000000000000001', 'bridged'), entryOf('false', 'false'));
  check('own-skip-bridge-forward', sentToQQ.length, 0);
  // 无门控频道：命令/AI 回复同步到 QQ
  await bridge.handleOwnDiscordMessage(ownMessage('9000000000000000099', 'AI reply'), entryOf('false', 'false'));
  check('own-forward-open', sentToQQ.length, 1);
  check('own-forward-open-id', sentToQQ[0]?.id, '9000000000000000099');
  // need_cmd 频道：非回复桥消息 → 跳过
  await bridge.handleOwnDiscordMessage(ownMessage('9000000000000000100', 'AI reply'), entryOf('false', 'true'));
  check('own-skip-need_cmd', sentToQQ.length, 1);
  // need_cmd 频道：回复桥消息 → 放行，回复引用透传
  await bridge.handleOwnDiscordMessage(ownMessage('9000000000000000101', 'AI reply', '9000000000000000001'), entryOf('false', 'true'));
  check('own-forward-need_cmd-reply', sentToQQ.length, 2);
  check('own-forward-reply-ref', sentToQQ[1]?.referenceId, '9000000000000000001');
  // 无内容占位消息（交互延迟等）不同步
  await bridge.handleOwnDiscordMessage(ownMessage('9000000000000000102', ''), entryOf('false', 'false'));
  check('own-skip-empty', sentToQQ.length, 2);

  // 乱序防回环：messageCreate 先于 registerDiscordMessage 到达（dcFromBridge 尚未登记）时，
  // 按「频道+正文」待发标记识别桥转发并跳过
  await bridge.sendWithReference(flakyChannel, { content: '桥转发内容', files: [] }, undefined);
  await bridge.handleOwnDiscordMessage(ownMessage('9000000000000000200', '桥转发内容'), entryOf('false', 'false'));
  check('own-skip-pending-send', sentToQQ.length, 2);
  // 核销只消费一条：同内容第二条（非桥转发）仍放行
  await bridge.handleOwnDiscordMessage(ownMessage('9000000000000000201', '桥转发内容'), entryOf('false', 'false'));
  check('own-pending-consumed-once', sentToQQ.length, 3);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
