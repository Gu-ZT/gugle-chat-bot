import { Message, PokeNoticeWSMSG } from '@/type';
import { QQBot } from '@/index';
import Constants from '@/constants';

export class Poke {
  public static processPokeMsg(bot: QQBot, msg: PokeNoticeWSMSG, sentMessage: Message[]) {
    if (!msg.group_id || !Constants.FUNCTION_POKE_GROUP.includes(msg.group_id)) return;
    const msgPool = ['零分', '负分', '下一个', '给我滚'];
    const banPool = [5 * 60, 10 * 60, 2 * 60, 20 * 60];
    const rand = Math.round(Math.random() * msgPool.length);
    sentMessage.push({
      type: 'text',
      data: {
        text: msgPool[rand] || '零分'
      }
    });
    bot.ban(msg.group_id, msg.user_id, banPool[rand] || (5 * 60))
  }
}
