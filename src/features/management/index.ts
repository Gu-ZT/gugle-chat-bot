import { QQBot } from '@/index';
import { GroupDecreaseNoticeWSMSG, GroupIncreaseNoticeWSMSG, GroupRequestWSMSG } from '@/type';
import { EventDataManager } from '@/event';
import { botConfig } from '@/config';

function handleGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG) {
  if (!botConfig.functionManagementGroup.includes(msg.group_id)) return;
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
  if (!botConfig.functionManagementGroup.includes(msg.group_id)) return;
  EventDataManager.getStorage('management', 'ban_list').then((banList: number[]) => {
    if (!banList) return;
    if (banList.includes(msg.user_id)) {
      if (msg.sub_type === 'invite' && botConfig.functionManagementOperator.includes(msg.operator_id)) {
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
  if (!botConfig.functionManagementGroup.includes(msg.group_id)) return;
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
}
