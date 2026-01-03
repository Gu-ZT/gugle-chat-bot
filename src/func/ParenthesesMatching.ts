import { GroupMessageWSMSG, Message, TextMessage } from '@/type';
import { QQBot } from '@/index';

export function parenthesesMatching(bot: QQBot, msg: GroupMessageWSMSG) {
  if (msg.group_id != 659356928) return;
  const receivedMessage: TextMessage[] = [];
  msg.message.forEach(message => {
    if (message.type != 'text') return;
    receivedMessage.push(message);
  });
  const bracketPairs: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>',
    '"': '"',
    '“': '”',
    '（': '）',
    '【': '】',
    '《': '》'
  };
  const closingBrackets = new Set([')', ']', '}', '>', '"', '”', '）', '】', '》']);

  const bracketTypeMap: Record<string, string> = {
    '（': 'paren',
    '）': 'paren',
    '【': 'square',
    '】': 'square',
    '(': 'paren',
    ')': 'paren',
    '[': 'square',
    ']': 'square',
    '{': 'brace',
    '}': 'brace',
    '<': 'angle',
    '>': 'angle',
    '"': 'quote',
    '“': 'quote',
    '”': 'quote',
    '《': 'book',
    '》': 'book'
  };

  const reversePairs: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
    '>': '<',
    '"': '"',
    '”': '“',
    '）': '（',
    '】': '【',
    '》': '《'
  };
  const stack: { char: string; position: number }[] = [];
  const strMsg = receivedMessage.map(msg => msg.data.text).join(' ');
  for (let i = 0; i < strMsg.length; i++) {
    const char: string = strMsg[i]!;
    if (bracketPairs[char]) {
      stack.push({ char, position: i });
    } else if (closingBrackets.has(char)) {
      const expected = reversePairs[char];
      if (stack.length > 0 && stack[stack.length - 1]!.char === expected) {
        stack.pop();
      } else {
        let errorMsg = `括号匹配错误：第 ${i + 1} 个字符 '${char}' `;
        if (stack.length === 0) {
          errorMsg += '没有对应的左括号';
        } else {
          const topBracket = stack[stack.length - 1]!;
          const expectedClosing = bracketPairs[topBracket.char];
          const topType = bracketTypeMap[topBracket.char];
          const currentType = bracketTypeMap[char];

          if (topType !== currentType) {
            errorMsg += `与第 ${topBracket.position + 1} 个字符 '${topBracket.char}' 类型不匹配，期望 '${expectedClosing}'`;
          } else {
            errorMsg += `位置错误`;
          }
        }

        const sentMessage: Message[] = [
          {
            type: 'reply',
            data: {
              id: msg.message_id
            }
          },
          {
            type: 'text',
            data: {
              text: errorMsg
            }
          }
        ];
        bot.sendGroupMsg(msg.group_id, sentMessage);
        return;
      }
    }
  }

  let result = '';
  while (stack.length > 0) {
    const leftBracket = stack.pop()!;
    result += bracketPairs[leftBracket.char];
  }
  if (result.trim().length == 0) return;
  const sentMessage: Message[] = [
    {
      type: 'reply',
      data: {
        id: msg.message_id
      }
    },
    {
      type: 'text',
      data: {
        text: result
      }
    }
  ];
  if (!!sentMessage) bot.sendGroupMsg(msg.group_id, sentMessage);
}