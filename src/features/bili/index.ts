import { QQBot } from '@/index';
import { GroupMessageWSMSG, Message } from '@/type';
import { ViewData } from '@/type/bili';
import { BiliImage } from '@/features/bili/image';

const BV_REG_EXP = /^BV[a-zA-Z0-9]{10}$/;
const AV_REG_EXP = /^av(\d+)$/;
const B23_REG_EXP = /^(https:\/\/)?(b23.tv\/[a-zA-Z0-9]{7})$/;

export class Bili {
  public static processMessage(bot: QQBot, msg: GroupMessageWSMSG, sentMessage: Message[]): Promise<void> {
    const bv = msg.raw_message.match(BV_REG_EXP);
    if (bv) {
      return Bili.getVideoInfo(bot, msg, bv[0], sentMessage);
    }
    const av = msg.raw_message.match(AV_REG_EXP);
    if (av) {
      return Bili.getVideoInfo(bot, msg, av[0], sentMessage);
    }
    return Promise.resolve();
  }

  public static getVideoInfo(bot: QQBot, msg: GroupMessageWSMSG, vid: string, sentMessage: Message[]) {
    const params = vid.startsWith('BV') ? { bvid: vid } : { aid: vid.slice(2) };
    return new Promise<void>((resolve, reject) => {
      bot.axiosInstance
        .get<{ data: ViewData }>('https://api.bilibili.com/x/web-interface/view', {
          params: {
            ...params
          }
        })
        .then(res => {
          const { data } = res.data;
          BiliImage.videoHandler(bot, data, bot.logger).then(result => {
            sentMessage.push({
              type: 'image',
              data: {
                file: `data:image/png;base64, ${result}`
              }
            });
            resolve();
          });
        })
        .catch(reject);
    });
  }
}
