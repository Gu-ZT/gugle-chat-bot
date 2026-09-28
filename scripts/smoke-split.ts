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
    result.attachments[0].name === 'image.png';
  console.log(`${ok ? 'OK  ' : 'FAIL'} splitQQMessage → ${JSON.stringify(result)}`);

  const pureImage = bridge.splitQQMessage({
    message: [{ type: 'image', data: { file: 'x', url: 'https://a.b/c.png' } }]
  });
  const ok2 = pureImage.text === '' && pureImage.attachments.length === 1 && pureImage.attachments[0].name === 'image.png';
  console.log(`${ok2 ? 'OK  ' : 'FAIL'} 纯图片 → ${JSON.stringify(pureImage)}`);

  // 按字节内容识别图片格式
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const ok3 =
    bridge.detectImageExt(png) === 'png' &&
    bridge.detectImageExt(jpg) === 'jpg' &&
    bridge.detectImageExt(gif) === 'gif' &&
    bridge.detectImageExt(webp) === 'webp' &&
    bridge.detectImageExt(Buffer.from('not an image at all')) === null;
  console.log(`${ok3 ? 'OK  ' : 'FAIL'} detectImageExt 识别 png/jpg/gif/webp/非图片`);

  process.exit(ok && ok2 && ok3 ? 0 : 1);
}

main().finally(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});
