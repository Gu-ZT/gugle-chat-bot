import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Discord 命令分发：! 前缀归一化 + 已注册命令根节点识别（未注册的 /xxx 不应被当作命令拦截）
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-command-'));
process.chdir(tmp);

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'discord-bridge.json'),
    JSON.stringify({ version: 1, token: '', bridges: {} })
  );

  const { normalizeCommandText } = await import('../src/command/index');
  const { CommandManager } = await import('gugle-command');
  const { DiscordBridge } = await import('../src/features/discord-bridge/index');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  // normalizeCommandText：! → /，其余原样
  check('normalize-!', normalizeCommandText('!mcv'), '/mcv');
  check('normalize-/', normalizeCommandText('/mcv'), '/mcv');
  check('normalize-plain', normalizeCommandText('mcv'), 'mcv');

  // 已注册命令根节点识别（复刻 handleDiscordCommand 的判定路径）
  const manager = new CommandManager();
  manager.register('gugle-command', CommandManager.literal('help'));
  manager.register('gugle-command', CommandManager.literal('mcv'));
  manager.register(
    'gugle-command',
    CommandManager.literal('github').then(CommandManager.literal('bind'))
  );
  const bridge = DiscordBridge.getInstance() as any;
  bridge.bot = { getCommandManager: () => manager };

  check('registered-mcv', bridge.isRegisteredCommand('mcv'), true);
  check('registered-github', bridge.isRegisteredCommand('github'), true);
  check('registered-help', bridge.isRegisteredCommand('help'), true);
  check('unregistered-foo', bridge.isRegisteredCommand('foo'), false);
  check('unregistered-send', bridge.isRegisteredCommand('send'), false); // /send 由桥单独处理
  check('unregistered-bind', bridge.isRegisteredCommand('bind'), false); // 子节点不算根命令

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
