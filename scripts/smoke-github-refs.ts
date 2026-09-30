import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// GitHub Issue/PR 引用解析：一条消息多个 #编号 全部解析、按 repository#number 去重、上限 10
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-refs-'));
process.chdir(tmp);

async function main() {
  const { Github } = await import('../src/features/github/index');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  // 多编号：全部解析，默认仓库
  check(
    'multi',
    Github.parseReferences('#5083 #5084 #5085 #5086 #5087 #5088'),
    [5083, 5084, 5085, 5086, 5087, 5088].map(number => ({ repository: 'Anvil-Dev/AnvilCraft', number }))
  );
  // 携带仓库前缀 + 混排默认仓库
  check('repo-prefix', Github.parseReferences('Anvil-Dev/AnvilCraft#100 和 #200'), [
    { repository: 'Anvil-Dev/AnvilCraft', number: 100 },
    { repository: 'Anvil-Dev/AnvilCraft', number: 200 }
  ]);
  check('other-repo', Github.parseReferences('foo/bar#1'), [{ repository: 'foo/bar', number: 1 }]);
  // 去重保序
  check('dedupe', Github.parseReferences('#1 #2 #1 #2'), [
    { repository: 'Anvil-Dev/AnvilCraft', number: 1 },
    { repository: 'Anvil-Dev/AnvilCraft', number: 2 }
  ]);
  // 不同仓库同号不去重
  check('dedupe-key', Github.parseReferences('a/b#1 #1'), [
    { repository: 'a/b', number: 1 },
    { repository: 'Anvil-Dev/AnvilCraft', number: 1 }
  ]);
  // 上限 10
  const many = Array.from({ length: 15 }, (_, i) => `#${i + 1}`).join(' ');
  check('cap', Github.parseReferences(many).length, 10);
  // 无引用
  check('none', Github.parseReferences('hello world'), []);
  // 正文混排
  check('inline', Github.parseReferences('请看 #5083 和 #5084 的讨论'), [
    { repository: 'Anvil-Dev/AnvilCraft', number: 5083 },
    { repository: 'Anvil-Dev/AnvilCraft', number: 5084 }
  ]);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
