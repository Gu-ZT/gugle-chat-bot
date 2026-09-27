import { isDiscordMarkdown, escapeDiscord } from '../src/features/discord-bridge/markdown';

const cases: Array<[string, boolean]> = [
  ['你好', false],
  ['**粗体**', true],
  ['`code`', true],
  ['[link](https://a.b)', true],
  ['a*b*c', false],
  ['2*3*5=30', false], // 算式不应误判为 markdown
  ['*斜体*', true],
  ['中文 *斜体* 文本', true],
  ['> 引用', true]
];

let failed = 0;
for (const [text, want] of cases) {
  const got = isDiscordMarkdown(text);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} isDiscordMarkdown(${JSON.stringify(text)}) = ${got} (want ${want})`);
}
console.log(`escape: ${escapeDiscord('**你好**_世界_')}`);
process.exit(failed === 0 ? 0 : 1);
