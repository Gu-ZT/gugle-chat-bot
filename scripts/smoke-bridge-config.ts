import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 在临时目录下运行，验证 ConfigStore 自动建文件 + normalize + /send 解析
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'));
process.chdir(tmp);

async function main() {
  // 先落盘配置，再加载模块（bridgeStore 为模块级单例，构造时读取文件）
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'discord-bridge.json'),
    JSON.stringify({
      version: 1,
      token: 'x',
      bridges: {
        '940551045929639949#general': { group: '659356928', need_reply: 'false', need_cmd: 'true' },
        '940551045929639949#dev': { group: 12345, need_reply: true, need_cmd: 'yes' },
        'bad-key': { group: '1' },
        '111#nocfg': 'not-an-object'
      }
    })
  );

  const { getDiscordBridgeConfig } = await import('../src/features/discord-bridge/index');

  const cfg = getDiscordBridgeConfig();
  console.log('bridges:', JSON.stringify(cfg.bridges, null, 2));
  const keys = Object.keys(cfg.bridges);
  const ok =
    keys.length === 2 &&
    cfg.bridges['940551045929639949#general']?.need_cmd === 'true' &&
    cfg.bridges['940551045929639949#dev']?.group === '12345' &&
    cfg.bridges['940551045929639949#dev']?.need_reply === 'true' &&
    cfg.bridges['940551045929639949#dev']?.need_cmd === 'false';
  console.log(ok ? 'CONFIG OK' : 'CONFIG FAIL');
  process.exit(ok ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
