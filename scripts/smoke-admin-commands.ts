import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 管理员运维命令：/reload 重载范围、/reboot 自重启拉起、/shutdown 停服退出、权限校验。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-admin-'));
process.chdir(tmp);

const ADMIN = 2308465862;

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'management.json'),
    JSON.stringify({ version: 1, groups: [703453948], operators: [ADMIN] })
  );
  fs.writeFileSync(path.join(tmp, 'configs', 'event-data.json'), JSON.stringify({ listeners: {}, storage: {} }));

  const admin = await import('../src/features/admin/index');
  const manager = await import('../src/config/manager');
  const { EventDataManager } = await import('../src/event/index');
  const { GitHubBindingManager } = await import('../src/features/github/binding');
  const { PeakValleyTimer } = await import('../src/features/peak-valley-timer');
  const { getFeatureConfig } = await import('../src/config/features');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  };

  // ── 1. ConfigStore 注册表：所有 store 都在册（新增配置不会漏重载） ──
  // 触发各功能 store 的懒加载（features/* 通过 getFeatureConfig 创建）
  getFeatureConfig('management');
  const storeCount = admin.registeredConfigStoreCount();
  check('config-stores-registered', storeCount > 0, true);

  // ── 2. /reload 覆盖 ConfigStore：改磁盘 → 重载 → 内存生效 ──
  const mgmtPath = path.join(tmp, 'configs', 'features', 'management.json');
  fs.writeFileSync(mgmtPath, JSON.stringify({ version: 1, groups: [999], operators: [ADMIN] }));
  check('before-reload-stale', getFeatureConfig('management').groups, [703453948]);
  const report = await admin.reloadRuntime({
    eventData: () => EventDataManager.reload(),
    githubBindings: () => GitHubBindingManager.reload(),
    extra: [{ name: '峰谷时段计时器', run: () => PeakValleyTimer.getInstance().reloadConfig() }]
  });
  check('reload-took-effect', getFeatureConfig('management').groups, [999]);
  check('reload-config-store-count', report.configStores > 0, true);
  check('reload-event-data', report.eventData, true);
  check('reload-github-bindings', report.githubBindings, true);
  check('reload-extras', report.extras, ['峰谷时段计时器']);

  // ── 3. /reload 覆盖事件数据：ban_list 从磁盘重读 ──
  await EventDataManager.setStorage('management', 'ban_list', [111]);
  const eventPath = path.join(tmp, 'configs', 'event-data.json');
  const onDisk = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
  onDisk.storage.management.ban_list = [222, 333];
  fs.writeFileSync(eventPath, JSON.stringify(onDisk, null, 2));
  await EventDataManager.reload();
  check('reload-event-data-ban-list', await EventDataManager.getStorage('management', 'ban_list'), [222, 333]);

  // ── 4. 单个模块重载失败不影响其余部分 ──
  const partial = await admin.reloadRuntime({
    eventData: async () => {
      throw new Error('磁盘损坏');
    },
    githubBindings: () => undefined,
    extra: [
      { name: '会失败', run: () => { throw new Error('x'); } },
      { name: '正常', run: () => undefined }
    ]
  });
  check('reload-partial-failure-continues', [partial.eventData, partial.githubBindings, partial.extras], [false, true, ['正常']]);

  // ── 5. /reboot：spawn 新进程（用 node -e 起一个短命进程验证 argv 透传与 pid） ──
  const markerFile = path.join(tmp, 'spawned-marker.txt');
  const childScript = `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'spawned');`;
  // onSpawned 注入为空实现：验证 spawn 逻辑但不让测试进程自己退出
  let exitScheduled = false;
  const pid = admin.spawnReplacementProcess([process.execPath, '-e', childScript], 0, () => {
    exitScheduled = true;
  });
  check('reboot-spawn-returns-pid', typeof pid === 'number' && pid > 0, true);
  check('reboot-exit-deferred-to-callback', exitScheduled, true);
  await new Promise(r => setTimeout(r, 700));
  check('reboot-spawn-new-process-ran', fs.existsSync(markerFile), true);

  // 默认回调会在 delayMs 后退出进程：用子进程验证真实行为
  const rebootScript = `
    const admin = require(${JSON.stringify(path.join(cwd, 'dist', 'features', 'admin', 'index.js'))});
    const pid = admin.spawnReplacementProcess([process.execPath, '-e', 'setTimeout(()=>{},50)'], 30);
    console.log('SPAWNED=' + (pid > 0));
  `;
  const hasAdminDist = fs.existsSync(path.join(cwd, 'dist', 'features', 'admin', 'index.js'));
  if (hasAdminDist) {
    const { execFileSync } = await import('node:child_process');
    const started = Date.now();
    const out = execFileSync(process.execPath, ['-e', rebootScript], { cwd: tmp, encoding: 'utf-8', timeout: 5000 });
    check('reboot-process-exits-after-spawn', out.includes('SPAWNED=true'), true);
    check('reboot-exit-within-buffer', Date.now() - started < 4000, true);
  } else {
    console.log('SKIP reboot-process-exits-after-spawn（无 dist 产物）');
  }

  // ── 6. /reboot：argv 为空时抛错（调用方可据此提示失败，不退出） ──
  let spawnError = '';
  try {
    admin.spawnReplacementProcess([], 0);
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }
  check('reboot-rejects-empty-argv', spawnError.includes('无法获取当前启动命令'), true);

  // ── 7. isRestartedByCommand：环境变量标记 ──
  check('restart-flag-absent', admin.isRestartedByCommand(), false);
  process.env.QQBOT_RESTARTED_BY_COMMAND = '1';
  check('restart-flag-present', admin.isRestartedByCommand(), true);
  delete process.env.QQBOT_RESTARTED_BY_COMMAND;

  // ── 8. /shutdown：调 stopBot 并安排退出（此处只验 stop 被调用，不真退出） ──
  // shutdownApplication 会 setTimeout(process.exit)，用子进程验证真实行为
  const shutdownScript = `
    const { shutdownApplication } = require(${JSON.stringify(path.join(cwd, 'dist', 'features', 'admin', 'index.js'))});
    let stopped = false;
    shutdownApplication(() => { stopped = true; console.log('STOP_CALLED=' + stopped); }, 50);
  `;
  const hasDist = fs.existsSync(path.join(cwd, 'dist', 'features', 'admin', 'index.js'));
  if (hasDist) {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['-e', shutdownScript], { cwd: tmp, encoding: 'utf-8', timeout: 5000 });
    check('shutdown-calls-stop-and-exits', out.includes('STOP_CALLED=true'), true);
  } else {
    console.log('SKIP shutdown-calls-stop-and-exits（无 dist 产物，改用直接逻辑校验）');
    let stopped = false;
    // 直接校验 shutdownApplication 会同步调用 stopBot（不触发真实退出）
    const originalExit = process.exit;
    (process as any).exit = ((code?: number) => {
      throw { __exit: code };
    }) as never;
    try {
      admin.shutdownApplication(() => {
        stopped = true;
      }, 10_000);
      check('shutdown-calls-stop', stopped, true);
    } finally {
      (process as any).exit = originalExit;
    }
  }

  process.chdir(cwd);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ConfigStore watcher 持有句柄时清理可能失败，不影响断言
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
