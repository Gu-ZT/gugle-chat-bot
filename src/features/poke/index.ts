import { Message, PokeNoticeWSMSG } from '@/type';
import { QQBot } from '@/index';
import Constants from '@/constants';
import dayjs from 'dayjs';

export class Poke {
  public static processPokeMsg(bot: QQBot, msg: PokeNoticeWSMSG, sentMessage: Message[]) {
    const hour = dayjs().hour();
    if (hour > 7 && hour < 21) return;
    if (!msg.group_id || !Constants.FUNCTION_POKE_GROUP.includes(msg.group_id)) return;
    const loginInfo = bot.getLoginInfoSync();
    if (!loginInfo || msg.target_id !== loginInfo.user_id) return;
    const msgPool = ['下一个', '零分', '负分', '给我滚'];
    const banPool = [60, 120, 240, 300];
    const rand = Math.round(Math.random() * msgPool.length);
    sentMessage.push({
      type: 'text',
      data: {
        text: msgPool[rand] || '零分'
      }
    });
    bot.ban(msg.group_id, msg.user_id, banPool[rand] || 120);
  }
}
