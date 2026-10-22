import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// /reboot 自重启回归测试。
//
// 生产事故（2026-10-22）：生产用 `tsx src/index.ts` 运行，tsx 加载器参数在 process.execArgv，
// 旧实现只转发 process.argv → 新进程变成裸 node 执行 .ts → `@/` 别名解析失败
// （ERR_MODULE_NOT_FOUND: Cannot find package '@/config'），且父进程无条件退出 → 机器人离线。
//
// 本测试覆盖：
// 1. buildRestartCommand 必须保留 execArgv（原缺陷）；
// 2. 真实 tsx 场景下端到端拉起 fixture 入口，断言 @/ 别名可解析、进程存活；
// 3. 子进程秒退时回滚：父进程不退出、返回失败原因；
// 4. 启动延迟 env 正确注入（避免与旧连接互踢）；
// 5. 并发触发被拒绝。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-reboot-'));
process.chdir(tmp);

const FIXTURE = path.join(cwd, 'scripts', 'fixtures', 'reboot-entry.ts');

async function main() {
  const admin = await import('../src/features/admin/index');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  };
  const checkContains = (name: string, haystack: string, needle: string) => {
    const ok = haystack.includes(needle);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${ok ? 'contains' : 'MISSING'} ${JSON.stringify(needle)}`);
  };

  // ── 1. buildRestartCommand：必须保留 execArgv（这是生产事故的根因） ──
  const fakeExecArgv = ['--require', '/x/preflight.cjs', '--import', 'file:///x/loader.mjs'];
  const cmd = admin.buildRestartCommand('/usr/bin/node', fakeExecArgv, ['/usr/bin/node', '/data/src/index.ts']);
  check('build-command-exec', cmd.command, '/usr/bin/node');
  check('build-command-keeps-execArgv', cmd.args, [...fakeExecArgv, '/data/src/index.ts']);
  checkContains('build-command-has-preflight', cmd.args.join(' '), 'preflight.cjs');
  checkContains('build-command-has-loader', cmd.args.join(' '), 'loader.mjs');

  // eval 相关参数必须剔除（否则子进程会把入口当表达式）
  const evalCmd = admin.buildRestartCommand('/usr/bin/node', ['--eval', 'code', '--print', 'x', '-e', 'y'], [
    '/usr/bin/node',
    '/data/src/index.ts'
  ]);
  check('build-command-filters-eval', evalCmd.args, ['/data/src/index.ts']);

  // argv 为空 → 抛错
  let emptyArgvError = '';
  try {
    admin.buildRestartCommand('/usr/bin/node', [], ['/usr/bin/node']);
  } catch (error) {
    emptyArgvError = error instanceof Error ? error.message : String(error);
  }
  checkContains('build-command-rejects-empty-argv', emptyArgvError, '无法获取当前启动命令');

  // ── 2. 真实 tsx 场景（原测试盲区）：端到端拉起 fixture，验证 @/ 别名可解析 ──
  // 注意：tsx 依赖 cwd 下的 tsconfig 解析 @/ 别名，故显式传 cwd=仓库根
  // （生产 cwd=/data，与 tsconfig 同级；测试进程已 chdir 到临时目录）。
  const logDir = path.join(tmp, 'logs');
  let exitCalled = false;
  // 用「当前进程的 node + execArgv」重建命令，入口指向 fixture：
  // 等价于生产里 tsx 拉起 src/index.ts 的场景
  const realCmd = admin.buildRestartCommand(process.execPath, process.execArgv, [process.execPath, FIXTURE]);
  const result = await admin.restartApplication({
    restartCommand: realCmd,
    healthCheckMs: 1200,
    exitDelayMs: 0,
    startDelayMs: 0,
    logDir,
    cwd,
    exit: () => {
      exitCalled = true;
    }
  });
  check('tsx-child-alive', result.alive, true);
  // exit 通过 setTimeout(exitDelayMs) 安排：轮询等待，避免负载高时固定延时不够
  const waitUntil = async (predicate: () => boolean, timeoutMs = 3000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return predicate();
  };
  check('tsx-child-exit-called-on-success', await waitUntil(() => exitCalled), true);

  // 轮询等待子进程日志（tsx 冷启动 + 机器负载会让固定延时不可靠）
  const waitForLog = async (dir: string, needle: string, timeoutMs = 10_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    let content = '';
    while (Date.now() < deadline) {
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      content = files.length > 0 ? fs.readFileSync(path.join(dir, files[0]!), 'utf-8') : '';
      if (content.includes(needle)) return content;
      await new Promise(r => setTimeout(r, 100));
    }
    return content;
  };
  const childLog = await waitForLog(logDir, 'FIXTURE_ALIAS_OK');
  checkContains('tsx-child-started', childLog, 'FIXTURE_STARTED');
  // 核心断言：@/ 别名解析成功（旧实现会在这里崩）
  checkContains('tsx-child-alias-resolved', childLog, 'FIXTURE_ALIAS_OK');
  checkContains('tsx-child-keeps-execArgv', childLog, 'preflight.cjs');
  checkContains('tsx-child-start-delay-env', childLog, 'FIXTURE_START_DELAY=0');

  // ── 3. 子进程秒退 → 回滚：父进程不退出、返回失败原因 ──
  const failDir = path.join(tmp, 'logs-fail');
  let exitOnFailure = false;
  const badScript = path.join(tmp, 'bad-entry.js');
  fs.writeFileSync(badScript, 'console.error("BOOM_BOOT_FAILED"); process.exit(1);');
  const failedResult = await admin.restartApplication({
    restartCommand: { command: process.execPath, args: [badScript] },
    healthCheckMs: 1500,
    exitDelayMs: 0,
    startDelayMs: 0,
    logDir: failDir,
    exit: () => {
      exitOnFailure = true;
    }
  });
  check('failed-child-alive-false', failedResult.alive, false);
  check('failed-child-parent-keeps-running', exitOnFailure, false);
  // 日志写入与进程退出存在微小竞态，统一用轮询读取
  const failedLog = await (async () => {
    const deadline = Date.now() + 3000;
    let tail = failedResult.logTail ?? '';
    while (Date.now() < deadline && !tail.includes('BOOM_BOOT_FAILED')) {
      await new Promise(r => setTimeout(r, 100));
      const files = fs.existsSync(failDir) ? fs.readdirSync(failDir) : [];
      if (files.length > 0) tail = fs.readFileSync(path.join(failDir, files[0]!), 'utf-8');
    }
    return tail;
  })();
  checkContains('failed-child-log-tail', failedLog, 'BOOM_BOOT_FAILED');

  // ── 4. 不存在的入口 → 子进程立刻失败，同样回滚 ──
  let exitOnMissing = false;
  const missingResult = await admin.restartApplication({
    restartCommand: { command: process.execPath, args: [path.join(tmp, 'no-such-file.js')] },
    healthCheckMs: 1500,
    exitDelayMs: 0,
    startDelayMs: 0,
    logDir: path.join(tmp, 'logs-missing'),
    exit: () => {
      exitOnMissing = true;
    }
  });
  check('missing-entry-alive-false', missingResult.alive, false);
  check('missing-entry-parent-keeps-running', exitOnMissing, false);

  // ── 5. 并发触发：第二次被拒绝；失败退出后标记释放 ──
  // 用「会失败」的重启做并发验证：失败路径会释放 restartInProgress，
  // 而成功路径会保留标记直到进程退出（生产语义如此，此处不适用）。
  // 注意：restartApplication 在首个 await 之前就同步置位 restartInProgress，
  // 因此无需 sleep 等待——加 sleep 反而会在负载高时让第一次重启先结束，导致用例不稳定。
  const concurrent = admin.restartApplication({
    // 子进程立即以失败码退出：不依赖「400ms 后才退出」这类时间假设，
    // 否则机器负载高时 node 冷启动可能超过观察窗口，导致用例偶发失败。
    restartCommand: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
    healthCheckMs: 1500,
    exitDelayMs: 0,
    logDir: path.join(tmp, 'logs-concurrent'),
    exit: () => {}
  });
  check('restart-in-progress-flag-sync', admin.isRestartInProgress(), true);
  let concurrentError = '';
  try {
    await admin.restartApplication({ exit: () => {} });
  } catch (error) {
    concurrentError = error instanceof Error ? error.message : String(error);
  }
  checkContains('concurrent-reboot-rejected', concurrentError, '已有重启正在进行中');
  const concurrentResult = await concurrent.catch(() => ({ alive: true }));
  check('concurrent-restart-failed-as-designed', concurrentResult.alive, false);
  check('restart-flag-released', admin.isRestartInProgress(), false);

  // ── 6. QQBOT_RESTART_COMMAND 逃生口：设置后改走 shell 命令 ──
  delete process.env.QQBOT_RESTART_COMMAND;
  check('custom-restart-command-absent', admin.customRestartCommand(), undefined);
  // 用可注入 spawn 验证走 shell 分支（不真执行外部命令）
  let shellSpawnArgs: { command: unknown; options: Record<string, unknown> } | undefined;
  process.env.QQBOT_RESTART_COMMAND = 'pm2 restart gugle-qq-bot';
  check('custom-restart-command-read', admin.customRestartCommand(), 'pm2 restart gugle-qq-bot');
  const shellResult = await admin.restartApplication({
    healthCheckMs: 50,
    exitDelayMs: 0,
    logDir: path.join(tmp, 'logs-shell'),
    exit: () => {},
    // spawn 桩：返回一个「存活」的子进程，记录被调用的命令
    spawnImpl: ((command: unknown, opts: Record<string, unknown>) => {
      shellSpawnArgs = { command, options: opts };
      const listeners = new Map<string, () => void>();
      return {
        pid: 4242,
        once: (event: string, cb: () => void) => {
          listeners.set(event, cb);
          return undefined;
        },
        removeListener: () => undefined,
        unref: () => undefined
      };
    }) as never
  });
  delete process.env.QQBOT_RESTART_COMMAND;
  check('custom-restart-command-spawned', shellResult.alive, true);
  check('custom-restart-command-value', shellSpawnArgs?.command, 'pm2 restart gugle-qq-bot');
  check('custom-restart-command-uses-shell', shellSpawnArgs?.options.shell, true);

  // ── 7. restartStartDelayMs：仅被 /reboot 拉起时返回注入值 ──
  delete process.env.QQBOT_RESTARTED_BY_COMMAND;
  delete process.env.QQBOT_START_DELAY_MS;
  check('start-delay-normal-launch', admin.restartStartDelayMs(), 0);
  process.env.QQBOT_RESTARTED_BY_COMMAND = '1';
  process.env.QQBOT_START_DELAY_MS = '2500';
  check('start-delay-after-reboot', admin.restartStartDelayMs(), 2500);
  delete process.env.QQBOT_RESTARTED_BY_COMMAND;
  delete process.env.QQBOT_START_DELAY_MS;

  process.chdir(cwd);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // 日志 fd 未释放时清理可能失败，不影响断言
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
