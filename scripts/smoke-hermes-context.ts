// Hermes 会话上下文组装（纯函数）：多人共享历史按当前对话者标注归属，防串台
async function main() {
  const { buildConversationHistory, buildGroupContext, BG_PREFIX } = await import('../src/features/hermes/context');

  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
  };

  const history = [
    { role: 'user', content: '张三 (1001): 今天服务器好卡', userId: '1001' },
    { role: 'assistant', content: '是啊我也有点卡', userId: '1001', label: '张三 (1001)' },
    { role: 'user', content: '李四 (1002): 你们在说啥', userId: '1002' },
    { role: 'assistant', content: '在说服务器', userId: '1001', label: '张三 (1001)' },
    { role: 'user', content: 'Gugle (dc:555): hi from discord', userId: 'dc:555' },
    // 无 userId 的旧持久化条目（兼容：视为当前对话主线，不加前缀）
    { role: 'user', content: '张三 (1001): 旧消息' },
    { role: 'assistant', content: '旧回复' }
  ];

  // 张三视角：自己的消息原样，他人消息加背景前缀，回给别人的 assistant 消息标注对象
  const forZhangsan = buildConversationHistory(history, '1001');
  check('zhangsan-own-user', forZhangsan[0], { role: 'user', content: '张三 (1001): 今天服务器好卡' });
  check('zhangsan-own-assistant', forZhangsan[1], { role: 'assistant', content: '是啊我也有点卡' });
  check('zhangsan-other-user', forZhangsan[2], { role: 'user', content: `${BG_PREFIX} 李四 (1002): 你们在说啥` });
  check('zhangsan-discord-user', forZhangsan[4], { role: 'user', content: `${BG_PREFIX} Gugle (dc:555): hi from discord` });
  check('zhangsan-legacy-no-userid', forZhangsan[5], { role: 'user', content: '张三 (1001): 旧消息' });
  check('zhangsan-legacy-assistant', forZhangsan[6], { role: 'assistant', content: '旧回复' });

  // 李四视角：张三的消息变背景；回复给张三的 assistant 消息标注「你回复 张三 的话」
  const forLisi = buildConversationHistory(history, '1002');
  check('lisi-other-user', forLisi[0], { role: 'user', content: `${BG_PREFIX} 张三 (1001): 今天服务器好卡` });
  check('lisi-assistant-to-other', forLisi[1], {
    role: 'assistant',
    content: '[你回复 张三 (1001) 的话] 是啊我也有点卡'
  });
  check('lisi-own-user', forLisi[2], { role: 'user', content: '李四 (1002): 你们在说啥' });

  // Discord 用户视角：QQ 成员的消息是背景
  const forDiscord = buildConversationHistory(history, 'dc:555');
  check('discord-qq-user-bg', forDiscord[0], { role: 'user', content: `${BG_PREFIX} 张三 (1001): 今天服务器好卡` });
  check('discord-own', forDiscord[4], { role: 'user', content: 'Gugle (dc:555): hi from discord' });

  // 群聊上下文系统提示：声明当前对话者与标注约定
  const groupCtx = buildGroupContext({ type: 'group', groupId: '659356928', userId: '1001' }, '张三 (1001)');
  check('group-ctx-current-speaker', groupCtx.includes('当前与你对话的是 张三 (1001)'), true);
  check('group-ctx-bg-convention', groupCtx.includes(BG_PREFIX), true);
  check('group-ctx-where', groupCtx.includes('QQ 群 659356928'), true);

  const dcCtx = buildGroupContext(
    { type: 'discord', groupId: '659356928', userId: 'dc:555', channelId: '1' },
    'Gugle (dc:555)'
  );
  check('discord-ctx-channel', dcCtx.includes('#'), true);
  check('discord-ctx-current-speaker', dcCtx.includes('当前与你对话的是 Gugle (dc:555)'), true);

  process.exit(failed === 0 ? 0 : 1);
}

main();
