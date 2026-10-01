import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 技能系统：[SKILL:...] 标签解析执行、管理员门控、执行摘要（mock 群管理 API）；
// 卡片类公共技能（查Issue / B站视频）的参数校验与图片产出传递
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
  const bot = {} as any; // 管理技能不触网，卡片技能的错误路径也不触网
  const route = { type: 'group' as const, groupId: '659356928', userId: '2308465862' };
  const admin = { bot, api, isAdmin: () => true };
  const notAdmin = { bot, api, isAdmin: () => false };

  // 无标签 → 原文返回，无图片
  check('no-tags', await manager.processTags('普通回复', route, admin), { text: '普通回复', images: [] });

  // 管理员执行禁言：标签移除 + 摘要附加 + API 调用（分钟→秒）
  calls.length = 0;
  const muted = await manager.processTags('好的。[SKILL:禁言 123456 10]', route, admin);
  check('mute-text', muted.text, '好的。\n\n✅ 已禁言 123456 10 分钟');
  check('mute-call', calls, [{ action: 'set_group_ban', params: ['659356928', '123456', 600] }]);

  // 解除禁言（duration=0）
  calls.length = 0;
  const unmuted = await manager.processTags('[SKILL:解除禁言 123456]', route, admin);
  check('unmute-text', unmuted.text, '✅ 已解除 123456 的禁言');
  check('unmute-call', calls, [{ action: 'set_group_ban', params: ['659356928', '123456', 0] }]);

  // 踢出
  calls.length = 0;
  await manager.processTags('[SKILL:踢出 123456]', route, admin);
  check('kick-call', calls, [{ action: 'set_group_kick', params: ['659356928', '123456'] }]);

  // 全员禁言 开/关
  calls.length = 0;
  await manager.processTags('[SKILL:全员禁言 开]', route, admin);
  await manager.processTags('[SKILL:全员禁言 关]', route, admin);
  check('whole-ban-call', calls, [
    { action: 'set_group_whole_ban', params: ['659356928', true] },
    { action: 'set_group_whole_ban', params: ['659356928', false] }
  ]);

  // 非管理员 → 不执行，提示仅管理员可用
  calls.length = 0;
  const denied = await manager.processTags('[SKILL:禁言 123456 10]', route, notAdmin);
  check('not-admin-text', denied.text, '❌ 禁言: 仅管理员可用');
  check('not-admin-no-call', calls, []);

  // 未知技能
  const unknown = await manager.processTags('[SKILL:飞天 1]', route, admin);
  check('unknown-skill', unknown.text, '❌ 飞天: 未知技能: 飞天');

  // 参数错误：缺时长 / 非法开关
  const badArgs = await manager.processTags('[SKILL:禁言 123456]', route, admin);
  check('bad-args', badArgs.text, '❌ 禁言: 时长无效，格式: 禁言 <QQ号> <时长(分钟)>');
  const badSwitch = await manager.processTags('[SKILL:全员禁言 也许]', route, admin);
  check('bad-switch', badSwitch.text, '❌ 全员禁言: 参数无效，请使用 开 或 关');

  // 时长上限：43200 分钟封顶
  calls.length = 0;
  const capped = await manager.processTags('[SKILL:禁言 123456 999999]', route, admin);
  check('cap-call', calls, [{ action: 'set_group_ban', params: ['659356928', '123456', 43200 * 60] }]);
  check('cap-text', capped.text, '✅ 已禁言 123456 43200 分钟');

  // 多标签同行执行
  calls.length = 0;
  const multi = await manager.processTags('处理中[SKILL:禁言 111 5]然后[SKILL:踢出 222]', route, admin);
  check('multi-call-count', calls.length, 2);
  check('multi-text', multi.text, '处理中然后\n\n✅ 已禁言 111 5 分钟\n✅ 已将 222 踢出群聊');

  // ── 卡片类公共技能（错误路径不触网） ──
  // 查Issue：缺参数 / 无编号 / 群未启用 github 功能
  const noArg = await manager.processTags('[SKILL:查Issue]', route, admin);
  check('issue-no-arg', noArg.text, '❌ 查Issue: 缺少编号，格式: 查Issue <owner/repo#编号 或 #编号>');
  const noRef = await manager.processTags('[SKILL:查Issue 随便说说]', { type: 'user' as const, userId: '1' }, admin);
  check('issue-no-ref', noRef.text, '❌ 查Issue: 未识别到 Issue/PR 编号，格式: 查Issue <owner/repo#编号 或 #编号>');
  const notEnabled = await manager.processTags('[SKILL:查Issue #123]', route, admin);
  check('issue-group-not-enabled', notEnabled.text, '❌ 查Issue: 本群未启用 GitHub 功能');
  // 卡片技能是公共技能：非管理员不因 adminOnly 被拒（会走到功能门控/参数校验）
  const publicSkill = await manager.processTags('[SKILL:查Issue]', route, notAdmin);
  check('issue-public-not-admin-gated', publicSkill.text, '❌ 查Issue: 缺少编号，格式: 查Issue <owner/repo#编号 或 #编号>');

  // B站视频：缺参数 / 无法识别的视频号
  const biliNoArg = await manager.processTags('[SKILL:B站视频]', route, admin);
  check('bili-no-arg', biliNoArg.text, '❌ B站视频: 缺少视频号，格式: B站视频 <BV号/av号/b23.tv短链>');
  const biliBad = await manager.processTags('[SKILL:B站视频 不是视频号]', route, admin);
  check('bili-bad-vid', biliBad.text.includes('无法识别的视频号'), true);

  // 图片产出传递：注入测试技能返回 images，processTags 原样汇集
  (manager as any).skills.push({
    name: '测试图',
    usage: '测试图',
    description: '测试',
    adminOnly: false,
    execute: async () => ({ message: '图好了', images: ['base64://AAA', 'BBB'] })
  });
  (manager as any).skillIndex.set('测试图', (manager as any).skills[(manager as any).skills.length - 1]);
  const withImages = await manager.processTags('看图[SKILL:测试图]', route, admin);
  check('skill-images-text', withImages.text, '看图\n\n✅ 图好了');
  check('skill-images', withImages.images, ['base64://AAA', 'BBB']);

  // 技能提示词包含公共技能分组与管理技能分组
  const prompt = manager.buildPrompt();
  check('prompt-header', prompt.includes('## 可用技能'), true);
  check('prompt-admin-section', prompt.includes('管理技能（仅管理员可用）'), true);
  check('prompt-usage', prompt.includes('[SKILL:技能名 参数...]'), true);
  check('prompt-public-skills', prompt.includes('查Issue') && prompt.includes('B站视频'), true);
  check('prompt-card-hint', prompt.includes('卡片类技能'), true);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
