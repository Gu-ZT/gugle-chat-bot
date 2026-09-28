import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// QQ 消息段拆分：文本与附件分离，验证图片段不再混入文本
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-split-'));
process.chdir(tmp);

async function main() {
  fs.mkdirSync(path.join(tmp, 'configs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'configs', 'features', 'discord-bridge.json'),
    JSON.stringify({ version: 1, token: '', bridges: {} })
  );

  const { DiscordBridge } = await import('../src/features/discord-bridge/index');
  const bridge = DiscordBridge.getInstance() as any;

  const fakeMsg = {
    message: [
      { type: 'text', data: { text: '看图 ' } },
      { type: 'image', data: { file: 'x', url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc_def' } },
      { type: 'text', data: { text: ' 怎么样' } }
    ]
  };

  const result = bridge.splitQQMessage(fakeMsg);
  const ok =
    result.text === '看图  怎么样' &&
    result.attachments.length === 1 &&
    result.attachments[0].url === 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc_def' &&
    result.attachments[0].name === 'download';
  console.log(`${ok ? 'OK  ' : 'FAIL'} splitQQMessage → ${JSON.stringify(result)}`);

  const pureImage = bridge.splitQQMessage({
    message: [{ type: 'image', data: { file: 'x', url: 'https://a.b/c.png' } }]
  });
  const ok2 = pureImage.text === '' && pureImage.attachments.length === 1 && pureImage.attachments[0].name === 'c.png';
  console.log(`${ok2 ? 'OK  ' : 'FAIL'} 纯图片 → ${JSON.stringify(pureImage)}`);

  process.exit(ok && ok2 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
