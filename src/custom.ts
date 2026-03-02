import { bot, QQBot } from '@/index';
import { GroupMessageWSMSG, Message, PokeNoticeWSMSG } from '@/type';
import { ParenthesesMatching } from '@/features/parentheses';
import { Github } from '@/features/github';
import { Poke } from '@/features/poke';

class CustomBot {
  @bot.subscribe('notice-event-poke', false)
  public listenPokeMsg(bot: QQBot, msg: PokeNoticeWSMSG): void {
    const sentMessage: Message[] = [
      {
        type: 'at',
        data: {
          qq: msg.user_id
        }
      },
      {
        type: 'text',
        data: {
          text: ' '
        }
      }
    ];
    Poke.processPokeMsg(bot, msg, sentMessage);
    if (sentMessage.length > 2) {
      if (msg.group_id) {
        bot.sendGroupMsg(msg.group_id, sentMessage);
      } else {
        bot.sendPrivateMsg(msg.user_id, sentMessage);
      }
    }
  }

  @bot.subscribe('message-event-group', false)
  public listenGroupMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    const sentMessage: Message[] = [
      {
        type: 'reply',
        data: {
          id: msg.message_id
        }
      }
    ];
    ParenthesesMatching.parenthesesMatching(msg, sentMessage);
    Github.processMessage(bot, msg, sentMessage).then(() => {
      if (sentMessage.length > 1) {
        bot.sendGroupMsg(msg.group_id, sentMessage);
      }
    });
  }
}

export default function run() {
  return new CustomBot();
}
