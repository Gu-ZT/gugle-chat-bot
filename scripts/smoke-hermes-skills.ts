import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 技能系统：[SKILL:...] 标签解析执行、管理员门控、执行摘要（mock 群管理 API）
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skills-'));
process.chdir(tmp);

async function main() {
  const { SkillManager } = await import('../src/features/hermes/skills');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  const manager = new SkillManager();
  const calls: Array<{ action: string; params: unknown[] }> = [];
  const api = {
    setGroupBan: async (groupId: string, userId: string, durationSec: number) => {
      calls.push({ action: 'set_group_ban', params: [groupId, userId, durationSec] });
    },
    setGroupKick: async (groupId: string, userId: string) => {
      calls.push({ action: 'set_group_kick', params: [groupId, userId] });
    },
    setGroupWholeBan: async (groupId: string, enable: boolean) => {
      calls.push({ action: 'set_group_whole_ban', params: [groupId, enable] });
    }
  };
  const route = { type: 'group' as const, groupId: '659356928', userId: '2308465862' };
  const admin = { isAdmin: () => true };
  const notAdmin = { isAdmin: () => false };

  // 无标签 → 原文返回
  check('no-tags', await manager.processTags('普通回复', route, { api, ...admin }), '普通回复');

  // 管理员执行禁言：标签移除 + 摘要附加 + API 调用（分钟→秒）
  calls.length = 0;
  const muted = await manager.processTags('好的。[SKILL:禁言 123456 10]', route, { api, ...admin });
  check('mute-text', muted, '好的。\n\n✅ 已禁言 123456 10 分钟');
  check('mute-call', calls, [{ action: 'set_group_ban', params: ['659356928', '123456', 600] }]);

  // 解除禁言（duration=0）
  calls.length = 0;
  const unmuted = await manager.processTags('[SKILL:解除禁言 123456]', route, { api, ...admin });
  check('unmute-text', unmuted, '✅ 已解除 123456 的禁言');
  check('unmute-call', calls, [{ action: 'set_group_ban', params: ['659356928', '123456', 0] }]);

  // 踢出
  calls.length = 0;
  await manager.processTags('[SKILL:踢出 123456]', route, { api, ...admin });
  check('kick-call', calls, [{ action: 'set_group_kick', params: ['659356928', '123456'] }]);

  // 全员禁言 开/关
  calls.length = 0;
  await manager.processTags('[SKILL:全员禁言 开]', route, { api, ...admin });
  await manager.processTags('[SKILL:全员禁言 关]', route, { api, ...admin });
  check('whole-ban-call', calls, [
    { action: 'set_group_whole_ban', params: ['659356928', true] },
    { action: 'set_group_whole_ban', params: ['659356928', false] }
  ]);

  // 非管理员 → 不执行，提示仅管理员可用
  calls.length = 0;
  const denied = await manager.processTags('[SKILL:禁言 123456 10]', route, { api, ...notAdmin });
  check('not-admin-text', denied, '❌ 禁言: 仅管理员可用');
  check('not-admin-no-call', calls, []);

  // 未知技能
  const unknown = await manager.processTags('[SKILL:飞天 1]', route, { api, ...admin });
  check('unknown-skill', unknown, '❌ 飞天: 未知技能: 飞天');

  // 参数错误：缺时长 / 非法开关
  const badArgs = await manager.processTags('[SKILL:禁言 123456]', route, { api, ...admin });
  check('bad-args', badArgs, '❌ 禁言: 时长无效，格式: 禁言 <QQ号> <时长(分钟)>');
  const badSwitch = await manager.processTags('[SKILL:全员禁言 也许]', route, { api, ...admin });
  check('bad-switch', badSwitch, '❌ 全员禁言: 参数无效，请使用 开 或 关');

  // 时长上限：43200 分钟封顶
  calls.length = 0;
  const capped = await manager.processTags('[SKILL:禁言 123456 999999]', route, { api, ...admin });
  check('cap-call', calls, [{ action: 'set_group_ban', params: ['659356928', '123456', 43200 * 60] }]);
  check('cap-text', capped, '✅ 已禁言 123456 43200 分钟');

  // 多标签同行执行
  calls.length = 0;
  const multi = await manager.processTags('处理中[SKILL:禁言 111 5]然后[SKILL:踢出 222]', route, { api, ...admin });
  check('multi-call-count', calls.length, 2);
  check('multi-text', multi, '处理中然后\n\n✅ 已禁言 111 5 分钟\n✅ 已将 222 踢出群聊');

  // 技能提示词包含管理技能分组
  const prompt = manager.buildPrompt();
  check('prompt-header', prompt.includes('## 可用技能'), true);
  check('prompt-admin-section', prompt.includes('管理技能（仅管理员可用）'), true);
  check('prompt-usage', prompt.includes('[SKILL:技能名 参数...]'), true);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
