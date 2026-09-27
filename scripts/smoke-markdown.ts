import { isDiscordMarkdown, escapeDiscord } from '../src/features/discord-bridge/markdown';

// /send 命令边界：只有「/send + 空白/结尾」才算命令，/sendxxx 不算
const SEND_COMMAND_PREFIX = '/send';
function isSendCommand(raw: string): boolean {
  return raw.startsWith(SEND_COMMAND_PREFIX) && (raw.length === SEND_COMMAND_PREFIX.length || /\s/.test(raw[SEND_COMMAND_PREFIX.length]!));
}
const sendCases: Array<[string, boolean]> = [
  ['/send 你好', true],
  ['/send', true],
  ['/send 你好 659356928', true],
  ['/sendxxx 你好', false],
  ['/sendtest', false],
  ['你好 /send', false]
];
let sendFailed = 0;
for (const [text, want] of sendCases) {
  const got = isSendCommand(text);
  const ok = got === want;
  if (!ok) sendFailed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} isSendCommand(${JSON.stringify(text)}) = ${got} (want ${want})`);
}

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
process.exit(failed === 0 && sendFailed === 0 ? 0 : 1);
