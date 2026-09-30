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

  process.exit(failed === 0 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
