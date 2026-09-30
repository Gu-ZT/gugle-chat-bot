import { QQBot } from '@/index';
import { GroupDecreaseNoticeWSMSG, GroupIncreaseNoticeWSMSG, GroupRequestWSMSG } from '@/type';
import { EventDataManager } from '@/event';
import { getFeatureConfig } from '@/config/features';

function handleGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG) {
  if (!getFeatureConfig('management').groups.includes(msg.group_id)) return;
  EventDataManager.getStorage('management', 'ban_list').then((banList: number[]) => {
    if (!banList) banList = [];
    if (banList.includes(msg.user_id)) return;
    banList.push(msg.user_id);
    EventDataManager.setStorage('management', 'ban_list', banList).then(() => {
      const reason = msg.sub_type === 'kick' ? '被管理员移出群聊' : '退出群聊';
      bot.getUserInfo(msg.user_id).then(userInfo => {
        bot.sendGroupMsg(msg.group_id, [
          {
            type: 'text',
            data: {
              text: `用户 ${userInfo.nickname}(${userInfo.user_id}) 已${reason}，现已加入黑名单，将自动拒绝后续加群申请！`
            }
          }
        ]);
      });
    });
  });
}

function handleGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG) {
  if (!getFeatureConfig('management').groups.includes(msg.group_id)) return;
  EventDataManager.getStorage('management', 'ban_list').then((banList: number[]) => {
    if (!banList) return;
    if (banList.includes(msg.user_id)) {
      if (msg.sub_type === 'invite' && getFeatureConfig('management').operators?.includes(msg.operator_id)) {
        banList = banList.filter(userId => userId !== msg.user_id);
        EventDataManager.setStorage('management', 'ban_list', banList).then();
        return;
      }
      bot.kick(msg.group_id, msg.user_id);
      bot.getUserInfo(msg.user_id).then(userInfo => {
        bot.sendGroupMsg(msg.group_id, [
          {
            type: 'text',
            data: {
              text: `黑名单用户 ${userInfo.nickname}(${userInfo.user_id}) 加群，已自动移出！`
            }
          }
        ]);
      });
    }
  });
}

function handleGroupRequest(bot: QQBot, msg: GroupRequestWSMSG) {
  if (!getFeatureConfig('management').groups.includes(msg.group_id)) return;
  if (msg.sub_type !== 'add') return;
  EventDataManager.getStorage('management', 'ban_list').then((banList: number[]) => {
    if (!banList) return;
    if (banList.includes(msg.user_id)) {
      bot.denyGroupAddRequest(msg.flag, '你已被拉入黑名单，系统自动拒绝！');
      bot.getUserInfo(msg.user_id).then(userInfo => {
        bot.sendGroupMsg(msg.group_id, [
          {
            type: 'text',
            data: {
              text: `黑名单用户 ${userInfo.nickname}(${userInfo.user_id}) 申请加群，已自动拒绝！`
            }
          }
        ]);
      });
    }
  });
}

export class Management {
  public static handleGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG) {
    handleGroupDecreaseNotice(bot, msg);
  }

  public static handleGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG) {
    handleGroupIncreaseNotice(bot, msg);
  }

  public static handleGroupRequest(bot: QQBot, msg: GroupRequestWSMSG) {
    handleGroupRequest(bot, msg);
  }

  /**
   * /pardon <QQ号>：把用户从黑名单移除（赦免）。
   * 仅限 management 功能启用的群 + operators 管理员使用。
   *
   * @param operatorId 操作者标识：QQ 管理员为 number（内部再校验 operators 白名单）；
   *                   Discord 管理员为 `dc:<用户ID>` 字符串（其服务器管理员身份已在
   *                   命令源层校验，这里仅做格式校验，字符串必须带 dc: 前缀）
   * @returns 返回是否成功赦免（true=已移除；false=不在黑名单/无权限）
   */
  public static async pardon(groupId: number, operatorId: number | string, userId: number): Promise<boolean> {
    const config = getFeatureConfig('management');
    if (!config.groups.includes(groupId)) return false;
    if (typeof operatorId === 'number') {
      if (!config.operators?.includes(operatorId)) return false;
    } else if (!operatorId.startsWith('dc:')) {
      return false;
    }

    const banList = (await EventDataManager.getStorage('management', 'ban_list')) as number[] | undefined;
    if (!banList || !banList.includes(userId)) return false;

    const next = banList.filter(id => id !== userId);
    await EventDataManager.setStorage('management', 'ban_list', next);
    return true;
  }
}
