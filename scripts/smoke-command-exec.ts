import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 命令执行包装：FailOnce 去重（/help abc 只报一次 Invalid command）、
// executeCommandTokens 精确回放（带空格参数不打散）、代理的鸭子类型保持
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-exec-'));
process.chdir(tmp);

function recordingSource(extra: Record<string, unknown> = {}): any {
  return {
    calls: [] as Array<{ method: string; message?: string }>,
    success(message: string) {
      this.calls.push({ method: 'success', message });
    },
    fail(message: string) {
      this.calls.push({ method: 'fail', message });
    },
    getName() {
      return 'tester';
    },
    hasPermission() {
      return true;
    },
    ...extra
  };
}

async function main() {
  const { executeCommand, executeCommandTokens, isBotCommandSource } = await import('../src/command/index');
  const { CommandManager, Arguments } = await import('gugle-command');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  const manager = new CommandManager();
  manager.register('gugle-command', CommandManager.literal('help').execute((source: any) => source.success('帮助内容')));
  manager.register(
    'gugle-command',
    CommandManager.literal('wiki').then(
      CommandManager.argument('query', Arguments.STRING).execute((source: any, query: string) =>
        source.success(`搜索结果:${query}`)
      )
    )
  );
  manager.register(
    'gugle-command',
    CommandManager.literal('github').then(
      CommandManager.literal('bind').then(
        CommandManager.argument('username', Arguments.STRING).execute((source: any, username: string) =>
          source.success(`绑定:${username}`)
        )
      )
    )
  );

  // /help：正常执行
  let source = recordingSource();
  executeCommand(manager, source, '/help');
  check('help-success', source.calls, [{ method: 'success', message: '帮助内容' }]);

  // /help abc：深层 parse 失败 + execute 兜底失败 → 只报一次
  source = recordingSource();
  executeCommand(manager, source, '/help abc');
  check('help-abc-fail-once', source.calls, [{ method: 'fail', message: 'Invalid command' }]);

  // /foo：完全未注册 → 只报一次
  source = recordingSource();
  executeCommand(manager, source, '/foo');
  check('foo-fail-once', source.calls, [{ method: 'fail', message: 'Invalid command' }]);

  // executeCommandTokens：带空格的字符串参数完整传入
  source = recordingSource();
  executeCommandTokens(manager, source, ['wiki', '下界 合金']);
  check('tokens-spaced-arg', source.calls, [{ method: 'success', message: '搜索结果:下界 合金' }]);

  // executeCommandTokens：子命令回放
  source = recordingSource();
  executeCommandTokens(manager, source, ['github', 'bind', 'Gugle']);
  check('tokens-subcommand', source.calls, [{ method: 'success', message: '绑定:Gugle' }]);

  // executeCommandTokens：未知命令只报一次
  source = recordingSource();
  executeCommandTokens(manager, source, ['nosuch']);
  check('tokens-invalid-once', source.calls, [{ method: 'fail', message: 'Invalid command' }]);

  // 代理保持鸭子类型：BotCommandSource 能力经代理后仍可识别
  const botLike = recordingSource({
    getUserId: () => 'dc:123',
    getGroupId: () => 659356928,
    isAdmin: () => true
  });
  let wrappedCalls: string[] = [];
  const { executeCommandTokens: execTokens } = await import('../src/command/index');
  void wrappedCalls;
  void execTokens;
  // 通过执行一个能检查 isBotCommandSource 的命令来验证
  manager.register(
    'gugle-command',
    CommandManager.literal('whoami').execute((src: any) => {
      src.success(isBotCommandSource(src) ? `bot:${src.getUserId()}:${src.isAdmin()}` : 'plain');
    })
  );
  executeCommandTokens(manager, botLike, ['whoami']);
  check('proxy-keeps-bot-source', botLike.calls, [{ method: 'success', message: 'bot:dc:123:true' }]);

  // 普通 CommandSource 经代理后仍不是 BotCommandSource
  source = recordingSource();
  executeCommandTokens(manager, source, ['whoami']);
  check('proxy-keeps-plain-source', source.calls, [{ method: 'success', message: 'plain' }]);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
