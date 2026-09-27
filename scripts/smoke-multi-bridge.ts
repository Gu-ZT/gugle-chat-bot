import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 多频道绑同一群：验证 QQ 侧逐条门控 + 回复按来源频道回传
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-multi-'));
process.chdir(tmp);

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'discord-bridge.json'),
    JSON.stringify({
      version: 1,
      token: '',
      bridges: {
        '940551045929639949#general': { group: '659356928', need_reply: 'false', need_cmd: 'true' },
        '940551045929639949#中文': { group: '659356928', need_reply: 'false', need_cmd: 'false' }
      }
    })
  );

  const { getDiscordBridgeConfig } = await import('../src/features/discord-bridge/index');
  const cfg = getDiscordBridgeConfig();

  // 模拟 handleQQMessage 的门控逻辑（不依赖真实 bot/discord 客户端）
  const bridges = Object.keys(cfg.bridges)
    .filter(key => cfg.bridges[key]!.group === '659356928')
    .map(key => ({ key, entry: cfg.bridges[key]! }));

  // 场景1：普通群消息（非回复）→ 只有 need_cmd=false 的 #中文 放行
  const allowedNormal = bridges.filter(
    b => !(b.entry.need_cmd === 'true' || b.entry.need_reply === 'true')
  );
  const ok1 = allowedNormal.length === 1 && allowedNormal[0]!.key === '940551045929639949#中文';
  console.log(`${ok1 ? 'OK  ' : 'FAIL'} 普通消息只转发到 #中文（general 被 need_cmd 拦下）`);

  // 场景2：回复来自 general 的桥消息 → 只有 general 放行（回复回到原频道）
  const replySourceKey = '940551045929639949#general';
  const allowedReply = bridges.filter(b => {
    if (b.entry.need_cmd === 'true' || b.entry.need_reply === 'true') {
      return replySourceKey === b.key;
    }
    return true;
  });
  const ok2 = allowedReply.length === 2 && allowedReply.some(b => b.key === replySourceKey);
  console.log(`${ok2 ? 'OK  ' : 'FAIL'} 回复 general 的桥消息 → general 放行（#中文 无需门控也放行）`);

  process.exit(ok1 && ok2 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
