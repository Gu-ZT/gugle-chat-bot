import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 管理员命令的权限门禁（回归测试）：
// 关键盲区：stub 的 isAdmin 从未被读取，导致「命令没有校验权限」也测不出来。
// 这里用「isAdmin 调用计数」+ /pardon 端到端，确认命令层真的读了 isAdmin。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-admin-guard-'));
process.chdir(tmp);

const ADMIN = 2308465862;
const TARGET = 2017065007;
const GROUP = 703453948;
const DC_ADMIN = '123456789012345678';
const DC_RANDOM = '987654321098765432';

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'management.json'),
    JSON.stringify({
      version: 1,
      groups: [GROUP],
      operators: [ADMIN],
      discordOperators: [`dc:${DC_ADMIN}`]
    })
  );
  fs.writeFileSync(path.join(tmp, 'configs', 'event-data.json'), JSON.stringify({ listeners: {}, storage: {} }));

  const { EventDataManager } = await import('../src/event/index');
  const { Management } = await import('../src/features/management/index');
  const { isDiscordOperator } = await import('../src/config/features');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  };

  const setBanList = (list: unknown[]) => EventDataManager.setStorage('management', 'ban_list', list);
  const banList = () => EventDataManager.getStorage('management', 'ban_list');

  // ── 1. isDiscordOperator：discordOperators 白名单（裸 ID 与 dc: 前缀等价） ──
  check('dc-operator-whitelisted', isDiscordOperator(DC_ADMIN), true);
  check('dc-operator-whitelisted-with-prefix', isDiscordOperator(`dc:${DC_ADMIN}`), true);
  check('dc-operator-not-whitelisted', isDiscordOperator(DC_RANDOM), false);

  // ── 2. 关键回归：非白名单 Discord 用户无法赦免（原缺陷：任意成员均可） ──
  await setBanList([TARGET]);
  check('random-discord-cannot-pardon', await Management.pardon(GROUP, `dc:${DC_RANDOM}`, TARGET), false);
  check('random-discord-no-effect', await banList(), [TARGET]);
  // 白名单 Discord 管理员可以
  check('whitelisted-discord-can-pardon', await Management.pardon(GROUP, `dc:${DC_ADMIN}`, TARGET), true);
  check('whitelisted-discord-cleared', await banList(), []);

  // ── 3. 伪造 dc: 前缀（空 ID、随机串）不能绕过 ──
  await setBanList([TARGET]);
  check('empty-dc-id-rejected', await Management.pardon(GROUP, 'dc:', TARGET), false);
  check('fake-dc-id-rejected', await Management.pardon(GROUP, 'dc:someone-else', TARGET), false);
  check('prefix-typo-rejected', await Management.pardon(GROUP, 'dcx:' + DC_ADMIN, TARGET), false);
  check('ban-list-intact', await banList(), [TARGET]);

  // ── 4. QQ 侧非 operators 成员无法赦免 ──
  check('qq-stranger-cannot-pardon', await Management.pardon(GROUP, 1000000, TARGET), false);
  check('qq-stranger-no-effect', await banList(), [TARGET]);

  // ── 5. 命令层确实读取 isAdmin()（不是只靠 Management 兜底） ──
  // 用真实 dispatch 路径跑一个「与 pardonCommand 同构」的命令，统计 isAdmin 调用次数
  const { CommandManager } = await import('gugle-command');
  const { executeCommand, resolveOperatorId } = await import('../src/command/index');
  const manager = new CommandManager();
  let isAdminReads = 0;
  let allowedById = '';
  manager.register(
    'gugle-command',
    CommandManager.literal('guardprobe').execute(async (source: any) => {
      const isAdmin = source.isAdmin();
      isAdminReads++;
      const op = resolveOperatorId(source);
      allowedById = Management.isOperatorAllowed(op) ? 'allowed' : 'denied';
      source.success(`admin=${isAdmin}`);
    })
  );
  const makeSource = (userId: string, isAdmin: boolean) => ({
    getUserId: () => userId,
    getGroupId: () => GROUP,
    isAdmin: () => isAdmin,
    getName: () => 'probe',
    hasPermission: () => isAdmin,
    success() {},
    fail() {}
  });
  executeCommand(manager, makeSource(`dc:${DC_RANDOM}`, false) as any, '/guardprobe');
  await new Promise(r => setTimeout(r, 200));
  check('dispatch-reads-isadmin', isAdminReads, 1);
  check('layer2-denies-random-dc', allowedById, 'denied');

  executeCommand(manager, makeSource(`dc:${DC_ADMIN}`, true) as any, '/guardprobe');
  await new Promise(r => setTimeout(r, 200));
  check('dispatch-reads-isadmin-twice', isAdminReads, 2);
  check('layer2-allows-whitelisted-dc', allowedById, 'allowed');

  process.chdir(cwd);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // watcher 句柄未释放时清理失败，不影响断言
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
