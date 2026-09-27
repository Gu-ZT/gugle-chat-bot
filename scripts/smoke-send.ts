import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// /send 参数解析：剥离命令前缀与可选目标，验证转发正文不含 /send
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-send-'));
process.chdir(tmp);

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'discord-bridge.json'),
    JSON.stringify({
      version: 1,
      token: '',
      bridges: {
        '940551045929639949#general': { group: '659356928', need_reply: 'false', need_cmd: 'true' },
        '940551045929639949#中文': { group: '659356928', need_reply: 'false', need_cmd: 'false' }
      }
    })
  );

  const { DiscordBridge } = await import('../src/features/discord-bridge/index');
  const bridge = DiscordBridge.getInstance() as any;

  const cases: Array<[string, { message: string; target?: string } | null]> = [
    ['/send 测试 940551045929639949#中文', { message: '测试', target: '940551045929639949#中文' }],
    ['/send 测试 #中文', { message: '测试', target: '940551045929639949#中文' }],
    ['/send 测试 659356928', { message: '测试', target: '940551045929639949#general' }], // 群号命中第一个绑定条目
    ['/send 测试', { message: '测试' }], // 无目标 → 默认第一个条目
    ['/send', null]
  ];

  let failed = 0;
  for (const [input, want] of cases) {
    const got = bridge.parseSendArgs(input);
    const ok =
      (got === null && want === null) ||
      (got !== null && want !== null && got.message === want.message && got.target === want.target);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} parseSendArgs(${JSON.stringify(input)}) = ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
