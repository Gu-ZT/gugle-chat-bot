import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 回归测试：/pardon 的权限判定与黑名单操作。
// 关键缺陷：命令源经 FailOnceCommandSource 代理后不再是 GroupMsgCommandSource 实例，
// 曾用 instanceof 判定平台导致 QQ 管理员被当成 Discord 用户 → 恒报「不在黑名单中」。
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-pardon-'));
process.chdir(tmp);

const ADMIN = 2308465862;
const TARGET = 2017065007;
const GROUP = 703453948;

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'management.json'),
    JSON.stringify({ version: 1, groups: [GROUP], operators: [ADMIN] })
  );
  fs.writeFileSync(path.join(tmp, 'configs', 'event-data.json'), JSON.stringify({ listeners: {}, storage: {} }));

  const { EventDataManager } = await import('../src/event/index');
  const { Management } = await import('../src/features/management/index');
  const { resolveOperatorId, isBotCommandSource, executeCommand } = await import('../src/command/index');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  };

  const banList = () => EventDataManager.getStorage('management', 'ban_list');
  const setBanList = (list: unknown[]) => EventDataManager.setStorage('management', 'ban_list', list);

  /** 构造与真实命令源同形态的 stub（QQ 群 / Discord 频道） */
  const qqSource = (qq: number) =>
    ({
      getUserId: () => String(qq),
      getGroupId: () => GROUP,
      isAdmin: () => true,
      getName: () => '管理员',
      hasPermission: () => true,
      success() {},
      fail() {}
    }) as any;
  const dcSource = (id: string) =>
    ({
      getUserId: () => `dc:${id}`,
      getGroupId: () => GROUP,
      isAdmin: () => true,
      getName: () => 'Discord 管理员',
      hasPermission: () => true,
      success() {},
      fail() {}
    }) as any;

  // ── 1. resolveOperatorId：平台判定不再依赖 instanceof ──
  check('qq-id-becomes-number', resolveOperatorId(qqSource(ADMIN)), ADMIN);
  check('qq-id-type', typeof resolveOperatorId(qqSource(ADMIN)), 'number');
  check('discord-id-stays-string', resolveOperatorId(dcSource('123456789')), 'dc:123456789');
  check('discord-id-type', typeof resolveOperatorId(dcSource('123456789')), 'string');
  check('non-bot-source-rejected', isBotCommandSource({} as any), false);
  check('bot-source-accepted', isBotCommandSource(qqSource(ADMIN)), true);

  // ── 2. 你遇到的场景：踢人进黑名单 → 管理员 /pardon → 必须成功 ──
  await setBanList([TARGET, 123456]);
  const operatorId = resolveOperatorId(qqSource(ADMIN));
  check('pardon-succeeds-after-fix', await Management.pardon(GROUP, operatorId, TARGET), true);
  check('target-removed', await banList(), [123456]);

  // ── 3. 不在黑名单 → 返回 false（提示「不在黑名单中」） ──
  check('not-in-list-false', await Management.pardon(GROUP, operatorId, TARGET), false);

  // ── 4. 非管理员 → 拒绝且不动数据 ──
  await setBanList([TARGET]);
  check('non-admin-rejected', await Management.pardon(GROUP, resolveOperatorId(qqSource(999999)), TARGET), false);
  check('non-admin-keeps-record', await banList(), [TARGET]);

  // ── 5. Discord 管理员 → 允许（dc: 分支） ──
  check('discord-admin-allowed', await Management.pardon(GROUP, resolveOperatorId(dcSource('123456789')), TARGET), true);
  check('discord-cleared', await banList(), []);

  // ── 6. 未启用群 → 拒绝且不动数据 ──
  await setBanList([TARGET]);
  check('disabled-group-rejected', await Management.pardon(111111, operatorId, TARGET), false);
  check('disabled-group-keeps-record', await banList(), [TARGET]);

  // ── 7. 黑名单里是字符串 id（历史数据）时也应能赦免 ──
  await setBanList([String(TARGET)]);
  check('string-id-pardon-succeeds', await Management.pardon(GROUP, operatorId, TARGET), true);
  check('string-id-cleaned', await banList(), []);

  // ── 8. 真实 dispatch 路径：代理后 isBotCommandSource 仍成立 ──
  // executeCommand 会用 FailOnceCommandSource 包裹，命令实现依赖鸭子类型判定
  const { CommandManager } = await import('gugle-command');
  const manager = new CommandManager();
  const received: Array<number | string> = [];
  manager.register(
    'gugle-command',
    CommandManager.literal('probe').execute((source: any) => {
      received.push(isBotCommandSource(source) ? resolveOperatorId(source) : 'NOT-BOT-SOURCE');
    })
  );
  const outputs: string[] = [];
  const sink: any = { ...qqSource(ADMIN), success: (m: string) => outputs.push(m), fail: (m: string) => outputs.push(m) };
  executeCommand(manager, sink, '/probe');
  await new Promise(r => setTimeout(r, 200));
  // 代理后仍是 BotCommandSource，且 QQ 号被还原为 number
  check('dispatch-keeps-bot-source', received, [ADMIN]);

  // ── 9. 端到端：被踢 → 自动写入黑名单（数字） → /pardon 成功 ──
  const ManagementModule = Management;
  const kicked: number[] = [];
  const kickedTexts: string[] = [];
  const botStub: any = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getUserInfo: async (id: number) => ({ user_id: String(id), nickname: '铁蛋' }),
    sendGroupMsg: async (_g: number, m: Array<{ data: { text?: string } }>) => {
      kickedTexts.push(m.map(s => s.data.text ?? '').join(''));
      return 1;
    },
    kick: async (_g: number, id: number) => {
      kicked.push(id);
    },
    approveGroupAddRequest: () => {},
    denyGroupAddRequest: (flag: string) => {
      kicked.push(-1 * Number(flag));
    }
  };

  await setBanList([]);
  ManagementModule.handleGroupDecreaseNotice(botStub, {
    notice_type: 'group_decrease',
    group_id: GROUP,
    user_id: TARGET,
    sub_type: 'kick',
    operator_id: ADMIN,
    self_id: 1
  } as any);
  await new Promise(r => setTimeout(r, 300));
  check('kick-writes-number', await banList(), [TARGET]);
  check('kick-notice-sent', kickedTexts.length, 1);

  const pardonAfterKick = await Management.pardon(GROUP, resolveOperatorId(qqSource(ADMIN)), TARGET);
  check('pardon-after-real-kick-succeeds', pardonAfterKick, true);
  check('pardon-after-real-kick-cleared', await banList(), []);

  // ── 10. 历史字符串条目存在时，踢人不重复写入（不产生数字+字符串两份） ──
  await setBanList([String(TARGET)]);
  ManagementModule.handleGroupDecreaseNotice(botStub, {
    notice_type: 'group_decrease',
    group_id: GROUP,
    user_id: TARGET,
    sub_type: 'leave',
    operator_id: ADMIN,
    self_id: 1
  } as any);
  await new Promise(r => setTimeout(r, 300));
  check('leave-normalizes-to-number', await banList(), [TARGET]);
  check('leave-no-duplicate-record', (await banList()).length, 1);

  // ── 11. 黑名单用户再次加群 → 自动踢出 ──
  kicked.length = 0;
  ManagementModule.handleGroupIncreaseNotice(botStub, {
    notice_type: 'group_increase',
    group_id: GROUP,
    user_id: TARGET,
    sub_type: 'approve',
    operator_id: 111,
    self_id: 1
  } as any);
  await new Promise(r => setTimeout(r, 300));
  check('increase-kicks-banned-user', kicked, [TARGET]);

  // ── 12. 黑名单用户申请加群 → 自动拒绝 ──
  kicked.length = 0;
  ManagementModule.handleGroupRequest(botStub, {
    request_type: 'group',
    group_id: GROUP,
    user_id: TARGET,
    flag: '42',
    sub_type: 'add',
    comment: '',
    self_id: 1
  } as any);
  await new Promise(r => setTimeout(r, 300));
  check('request-denies-banned-user', kicked, [-42]);

  process.chdir(cwd);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ConfigStore 的 fs.watch 仍持有目录句柄时删除可能失败（Windows），不影响断言结果
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
