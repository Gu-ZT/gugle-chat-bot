import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 回复分句与合并转发阈值（纯函数）：中英标点分句、收尾引号、空行/换行边界、
// 列表合并、代码块原子、未闭合围栏与 [SKILL:/MEDIA: 标签的 rest 保留、超长二次切分
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-reply-units-'));
process.chdir(tmp);

async function main() {
  const { shouldCompact, splitReplyIntoUnits, takeCompleteUnits } = await import(
    '../src/features/hermes/reply-units'
  );

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };
  /** 只比对单元文本，便于断言分句结果 */
  const texts = (units: Array<{ text: string }>) => units.map(unit => unit.text);

  // 阈值：任意维度命中即合并转发；0 关闭该维度；两个都为 0 永不转发
  const limits = { maxUnitLength: 0, compactMaxChars: 40, compactMaxLines: 5 };
  check('compact-empty', shouldCompact('', limits), false);
  check('compact-chars-40', shouldCompact('a'.repeat(40), limits), false);
  check('compact-chars-41', shouldCompact('a'.repeat(41), limits), true);
  check('compact-lines-5', shouldCompact('a\nb\nc\nd\ne', limits), false);
  check('compact-lines-6', shouldCompact('a\nb\nc\nd\ne\nf', limits), true);
  check('compact-chars-off', shouldCompact('a'.repeat(200), { ...limits, compactMaxChars: 0 }), false);
  check('compact-lines-off', shouldCompact('a\n'.repeat(20), { ...limits, compactMaxLines: 0 }), false);
  check('compact-all-off', shouldCompact('a\n'.repeat(200), { maxUnitLength: 0, compactMaxChars: 0, compactMaxLines: 0 }), false);

  // 分句：中文标点 / 英文标点 / 句末标点后的收尾引号
  check('split-cn', texts(splitReplyIntoUnits('你好。今天天气不错！', limits)), ['你好。', '今天天气不错！']);
  check('split-en', texts(splitReplyIntoUnits('Hello. How are you? Fine!', limits)), ['Hello.', 'How are you?', 'Fine!']);
  check('split-semicolon', texts(splitReplyIntoUnits('第一；第二;第三', limits)), ['第一；', '第二;', '第三']);
  check('split-ellipsis', texts(splitReplyIntoUnits('让我想想……算了吧。', limits)), ['让我想想……', '算了吧。']);
  check('split-closing-quote', texts(splitReplyIntoUnits('他说：“好的。”然后走了。', limits)), [
    '他说：“好的。”',
    '然后走了。'
  ]);
  check('split-closing-bracket', texts(splitReplyIntoUnits('看图（很重要！）再说。', limits)), ['看图（很重要！）', '再说。']);
  check('split-no-boundary', texts(splitReplyIntoUnits('没有标点的一段话', limits)), ['没有标点的一段话']);

  // 空行 / 换行是边界；空输入不产出单元
  check('split-blank-line', texts(splitReplyIntoUnits('第一段\n\n第二段', limits)), ['第一段', '第二段']);
  check('split-newline', texts(splitReplyIntoUnits('第一行\n第二行', limits)), ['第一行', '第二行']);
  check('split-punct-then-newline', texts(splitReplyIntoUnits('好的。\n下一段', limits)), ['好的。', '下一段']);
  check('split-empty', splitReplyIntoUnits('', limits), []);
  check('split-blank-only', splitReplyIntoUnits('  \n \n ', limits), []);
  check('split-trim', texts(splitReplyIntoUnits('  你好。  ', limits)), ['你好。']);

  // 列表：连续列表项行合并为一个单元，空行/普通段落断开
  check('list-dash', texts(splitReplyIntoUnits('- 苹果\n- 香蕉\n- 橘子', limits)), ['- 苹果\n- 香蕉\n- 橘子']);
  check('list-star', texts(splitReplyIntoUnits('* 甲\n* 乙\n\n普通段落', limits)), ['* 甲\n* 乙', '普通段落']);
  check('list-ordered', texts(splitReplyIntoUnits('1. 甲\n2. 乙\n3. 丙', limits)), ['1. 甲\n2. 乙\n3. 丙']);
  check('list-cn-ordered', texts(splitReplyIntoUnits('1、甲\n2、乙', limits)), ['1、甲\n2、乙']);
  check('list-then-paragraph', texts(splitReplyIntoUnits('- 甲\n- 乙\n结束语。', limits)), ['- 甲\n- 乙', '结束语。']);

  // 代码块原子：围栏内容绝不切分（含内部句末标点与空行）
  const fenced = '```js\nconst a = 1。\n\nconsole.log(a);\n```';
  check('fence-atomic', texts(splitReplyIntoUnits(`看代码。\n${fenced}\n完事。`, limits)), ['看代码。', fenced, '完事。']);
  check('fence-tilde', texts(splitReplyIntoUnits('~~~\na。b\n~~~', limits)), ['~~~\na。b\n~~~']);

  // takeCompleteUnits：未闭合围栏必须留在 rest（不得下发）
  const pending = takeCompleteUnits('好了。\n```js\nconst a = 1', limits);
  check('take-fence-open-units', texts(pending.units), ['好了。']);
  check('take-fence-open-rest', pending.rest, '```js\nconst a = 1');
  // 补齐围栏后即可整体下发
  const closed = takeCompleteUnits(pending.rest + '\n```\n后面还有。', limits);
  check('take-fence-closed-units', texts(closed.units), ['```js\nconst a = 1\n```', '后面还有。']);
  check('take-fence-closed-rest', closed.rest, '');

  // 标签保留：[SKILL: / MEDIA: 所在单元及其后的全部内容留在 rest
  const skill = takeCompleteUnits('好的。\n[SKILL:禁言 123 10]\n还有更多', limits);
  check('take-skill-units', texts(skill.units), ['好的。']);
  check('take-skill-rest', skill.rest, '[SKILL:禁言 123 10]\n还有更多');
  const skillInline = takeCompleteUnits('先这样[SKILL:禁言 123 10]。\n后面', limits);
  check('take-skill-inline-units', texts(skillInline.units), []);
  check('take-skill-inline-rest', skillInline.rest, '先这样[SKILL:禁言 123 10]。\n后面');
  const media = takeCompleteUnits('给你图。MEDIA:/tmp/a.png\n结束。', limits);
  check('take-media-units', texts(media.units), ['给你图。']);
  check('take-media-rest', media.rest, 'MEDIA:/tmp/a.png\n结束。');
  // 无标签时完整单元照常下发
  const plain = takeCompleteUnits('第一句。第二句。', limits);
  check('take-plain-units', texts(plain.units), ['第一句。', '第二句。']);
  check('take-plain-rest', plain.rest, '');

  // 流式：未成形的尾巴留在 rest，补全后并入下一批
  const streaming = takeCompleteUnits('你好。世界', limits);
  check('take-stream-units', texts(streaming.units), ['你好。']);
  check('take-stream-rest', streaming.rest, '世界');
  const streaming2 = takeCompleteUnits(`${streaming.rest}！`, limits);
  check('take-stream-next-units', texts(streaming2.units), ['世界！']);
  check('take-stream-next-rest', streaming2.rest, '');
  // 缓冲区以换行结尾时视为尚未成形（等下一段文本一并判定）
  check('take-trailing-newline', takeCompleteUnits('第一行\n', limits), { units: [], rest: '第一行\n' });

  // 超长单元二次切分：总计不丢字（空白裁剪除外），且逐块独立判定 asForward
  const longText = `${'甲'.repeat(30)}。${'乙'.repeat(30)}。`;
  const splitted = splitReplyIntoUnits(longText, { maxUnitLength: 20, compactMaxChars: 0, compactMaxLines: 0 });
  check('split-long-no-loss', splitted.map(unit => unit.text).join(''), longText.replace(/\s/g, ''));
  check('split-long-all-under-max', splitted.every(unit => unit.text.length <= 20), true);
  check('split-long-not-forward', splitted.every(unit => !unit.asForward), true);
  const longSingle = 'x'.repeat(100);
  const chunked = splitReplyIntoUnits(longSingle, { maxUnitLength: 30, compactMaxChars: 10, compactMaxLines: 0 });
  // splitMessageText 按 maxLength 硬切：100 字 → 30/30/30/10，故末块 10 字不超阈值
  check('split-long-chunk-count', chunked.length, 4);
  check('split-long-forward-flag', chunked.map(unit => unit.asForward), [true, true, true, false]);
  check('split-long-join', chunked.map(unit => unit.text).join(''), longSingle);
  // 阈值按「切分后的单块」判定：整段超长但每块都短 → 不合并转发
  const shortChunks = splitReplyIntoUnits('短句。'.repeat(6), { maxUnitLength: 8, compactMaxChars: 40, compactMaxLines: 0 });
  check('split-per-chunk-threshold', shortChunks.map(unit => unit.asForward), [false, false, false, false, false, false]);
  // maxUnitLength=0 不切分
  check(
    'split-no-max-unit',
    texts(splitReplyIntoUnits(longSingle, { maxUnitLength: 0, compactMaxChars: 0, compactMaxLines: 0 })),
    [longSingle]
  );

  // 不丢字：各类边界的最终模式拼接结果与输入一致（仅空白裁剪）
  const mixed = '开头\n\n- 甲\n- 乙\n\n```js\ncode。\n```\n结尾！“引用。”';
  const mixedUnits = splitReplyIntoUnits(mixed, limits);
  check('mixed-no-loss', mixedUnits.map(unit => unit.text).join('').replace(/\s/g, ''), mixed.replace(/\s/g, ''));
  check('mixed-unit-texts', texts(mixedUnits), ['开头', '- 甲\n- 乙', '```js\ncode。\n```', '结尾！', '“引用。”']);

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
