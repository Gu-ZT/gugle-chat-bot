import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 斜杠命令构建：命令树 → SlashCommandBuilder/规格 的映射
// （参数类型、必填规则、子命令、名称小写化）
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-build-'));
process.chdir(tmp);

async function main() {
  const { CommandManager, Arguments } = await import('gugle-command');
  const { ApplicationCommandOptionType } = await import('discord.js');
  const { buildSlashCommands } = await import('../src/features/discord-bridge/slash');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  // 与 custom.ts 一致的命令注册结构
  const manager = new CommandManager();
  manager.register('gugle-command', CommandManager.literal('help').execute(() => {}));
  manager.register('gugle-command', CommandManager.literal('mcv').execute(() => {}));
  manager.register(
    'gugle-command',
    CommandManager.literal('server').then(
      CommandManager.argument('ip', Arguments.STRING)
        .execute(() => {})
        .then(CommandManager.argument('port', Arguments.NUMBER).execute(() => {}))
    )
  );
  manager.register(
    'gugle-command',
    CommandManager.literal('wiki').then(CommandManager.argument('query', Arguments.STRING).execute(() => {}))
  );
  manager.register(
    'gugle-command',
    CommandManager.literal('github')
      .then(CommandManager.literal('bind').then(CommandManager.argument('username', Arguments.STRING).execute(() => {})))
      .then(
        CommandManager.literal('subscribe').then(CommandManager.argument('repository', Arguments.STRING).execute(() => {}))
      )
      .then(CommandManager.literal('allow').then(CommandManager.argument('target', Arguments.STRING).execute(() => {})))
  );
  manager.register(
    'gugle-command',
    CommandManager.literal('pardon').then(CommandManager.argument('userId', Arguments.STRING).execute(() => {}))
  );
  manager.register('gugle-command', CommandManager.literal('pvtime').execute(() => {}));

  const { builders, specs } = buildSlashCommands(manager);
  const byName = (name: string, sub?: string) => specs.find(s => s.name === name && s.subcommand === sub);

  // 顶命令数量
  check('builder-count', builders.map(b => b.name).sort(), ['github', 'help', 'mcv', 'pardon', 'pvtime', 'server', 'wiki']);

  // 无参命令
  check('spec-help', byName('help'), { name: 'help', options: [] });
  check('spec-pvtime', byName('pvtime'), { name: 'pvtime', options: [] });

  // /server <ip> [port]：ip 必填 String、port 选填 Number
  check('spec-server', byName('server'), {
    name: 'server',
    options: [
      { name: 'ip', type: ApplicationCommandOptionType.String, required: true },
      { name: 'port', type: ApplicationCommandOptionType.Number, required: false }
    ]
  });

  // /wiki <query>
  check('spec-wiki', byName('wiki'), {
    name: 'wiki',
    options: [{ name: 'query', type: ApplicationCommandOptionType.String, required: true }]
  });

  // /github bind|subscribe|allow 子命令
  check('spec-github-bind', byName('github', 'bind'), {
    name: 'github',
    subcommand: 'bind',
    options: [{ name: 'username', type: ApplicationCommandOptionType.String, required: true }]
  });
  check('spec-github-subscribe', byName('github', 'subscribe'), {
    name: 'github',
    subcommand: 'subscribe',
    options: [{ name: 'repository', type: ApplicationCommandOptionType.String, required: true }]
  });
  check('spec-github-allow', byName('github', 'allow'), {
    name: 'github',
    subcommand: 'allow',
    options: [{ name: 'target', type: ApplicationCommandOptionType.String, required: true }]
  });

  // /pardon <userId> → option 名小写化
  check('spec-pardon', byName('pardon'), {
    name: 'pardon',
    options: [{ name: 'userid', type: ApplicationCommandOptionType.String, required: true }]
  });

  // builders JSON 抽查：github 有 3 个子命令选项；server 的 port 不必填
  const githubJson = builders.find(b => b.name === 'github')!.toJSON();
  check(
    'json-github-subcommands',
    (githubJson.options ?? []).map(o => o.name).sort(),
    ['allow', 'bind', 'subscribe']
  );
  const serverJson = builders.find(b => b.name === 'server')!.toJSON();
  const portJson = (serverJson.options ?? []).find(o => o.name === 'port');
  check('json-port-optional', portJson?.required ?? false, false);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
