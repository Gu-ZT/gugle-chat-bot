import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermes 配置 normalize：缺省回退、坏类型剔除、关键词小写化、QQ 列表过滤
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-config-'));
process.chdir(tmp);

async function main() {
  const { normalizeHermesConfig, hermesConfigFactory } = await import('../src/features/hermes/config');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  // 非对象输入 → null
  check('null-input', normalizeHermesConfig(null), null);
  check('array-input', normalizeHermesConfig([]), null);
  check('string-input', normalizeHermesConfig('x'), null);

  // 空对象 → 全部默认值
  check('empty-object', normalizeHermesConfig({}), hermesConfigFactory());

  // 字段校验：坏类型回退默认，QQ 列表剔除非正整数，关键词小写化
  const normalized = normalizeHermesConfig({
    apiUrl: 'http://example.com:8642',
    apiKey: 123,
    groups: [659356928, 'abc', -1, 0],
    admins: [2308465862],
    keywordTriggers: ['XiaoMiao', '喵', 42, ''],
    requireMention: false,
    progressRateLimitSec: -5,
    forwardImages: false
  });
  check('apiUrl', normalized?.apiUrl, 'http://example.com:8642');
  check('apiKey-bad-type', normalized?.apiKey, '');
  check('groups-filter', normalized?.groups, [659356928]);
  check('admins', normalized?.admins, [2308465862]);
  check('keywords-lowercase', normalized?.keywordTriggers, ['xiaomiao', '喵']);
  check('requireMention', normalized?.requireMention, false);
  check('progressRateLimitSec-negative', normalized?.progressRateLimitSec, 15);
  check('forwardImages', normalized?.forwardImages, false);

  // 逐句发送 / 聊天记录阈值 / 私聊回执：默认值、坏类型回退、0 必须合法保留、空串合法
  const defaults = hermesConfigFactory();
  check('default-replyPerSentence', defaults.replyPerSentence, true);
  // 默认阈值按代码为准（当前 300 字），避免测试里重复硬编码字面量
  check('default-compactMaxChars', defaults.compactMaxChars, 300);
  check('default-compactMaxLines', defaults.compactMaxLines, 5);
  check('default-privateReactionFallbackText', defaults.privateReactionFallbackText, true);
  check('default-privateReceiptText', defaults.privateReceiptText, '🤔 收到，正在思考…');

  // 缺省字段回退必须与 factory 一致（阈值调整后不会漏改）
  const emptyNormalized = normalizeHermesConfig({});
  check('fallback-compactMaxChars-matches-factory', emptyNormalized?.compactMaxChars, defaults.compactMaxChars);
  check('fallback-compactMaxLines-matches-factory', emptyNormalized?.compactMaxLines, defaults.compactMaxLines);

  const zeroed = normalizeHermesConfig({ compactMaxChars: 0, compactMaxLines: 0 });
  check('compact-0-is-valid', [zeroed?.compactMaxChars, zeroed?.compactMaxLines], [0, 0]);

  const badTypes = normalizeHermesConfig({
    replyPerSentence: 'yes',
    compactMaxChars: 'many',
    compactMaxLines: -3,
    privateReactionFallbackText: 1,
    privateReceiptText: 42
  });
  check('replyPerSentence-bad-type', badTypes?.replyPerSentence, defaults.replyPerSentence);
  check('compactMaxChars-bad-type', badTypes?.compactMaxChars, defaults.compactMaxChars);
  check('compactMaxLines-negative', badTypes?.compactMaxLines, defaults.compactMaxLines);
  check('receiptFallback-bad-type', badTypes?.privateReactionFallbackText, defaults.privateReactionFallbackText);
  check('receiptText-bad-type', badTypes?.privateReceiptText, defaults.privateReceiptText);

  const overrides = normalizeHermesConfig({
    replyPerSentence: false,
    compactMaxChars: 80,
    compactMaxLines: 0,
    privateReactionFallbackText: false,
    privateReceiptText: '在想了'
  });
  check('replyPerSentence-override', overrides?.replyPerSentence, false);
  check('compactMaxChars-override', overrides?.compactMaxChars, 80);
  check('compactMaxLines-off', overrides?.compactMaxLines, 0);
  check('receiptFallback-off', overrides?.privateReactionFallbackText, false);
  check('receiptText-override', overrides?.privateReceiptText, '在想了');

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
