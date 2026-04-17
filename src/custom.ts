import { bot, QQBot } from '@/index';
import {
  GroupDecreaseNoticeWSMSG,
  GroupIncreaseNoticeWSMSG,
  GroupMessageWSMSG,
  GroupRequestWSMSG,
  Message,
  NotifyNoticeWSMSG
} from '@/type';
import { ParenthesesMatching } from '@/features/parentheses';
import { Github } from '@/features/github';
import { Poke } from '@/features/poke';
import { Arguments, CommandManager, CommandSource } from 'gugle-command';
import { MinecraftAPI } from '@/features/minecraft';
import { ModrinthAPI } from '@/features/modrinth';
import { EventDataManager } from '@/event';
import Constants from '@/constants';
import { Bili } from '@/features/bili';
import { Management } from '@/features/management';

class CustomBot {
  public static helpCommand(source: CommandSource) {
    source.success(`帮助
· /mcv：获取 Minecraft 版本信息
· /server <ip> <port?>：获取 Minecraft 服务器状态
· /wiki <query>：搜索 Minecraft 维基`);
  }

  public static minecraftVersionCommand(source: CommandSource) {
    MinecraftAPI.getVersion().then(version => {
      source.success(
        `Minecraft 版本信息
· 最新正式版：${version.latest.release}
· 最新快照版：${version.latest.snapshot}`
      );
    });
  }

  public static serverCommand(source: CommandSource, ip: string, port: number = 25565) {
    MinecraftAPI.getMinecraftServerStatus(ip, port).then(status => {
      if (!status.online) {
        source.success('服务器已离线');
        return;
      }
      let onlinePlayers = '';
      for (const player of status.players.list) {
        if (onlinePlayers) onlinePlayers += '\n';
        onlinePlayers += `  - ${player}`;
      }
      source.success(
        `${status.motd}
· 游戏版本：${status.version}
· 在线玩家：${status.players.online}/${status.players.max}
· 在线列表：\n` + onlinePlayers
      );
    });
  }

  public static wikiCommand(source: CommandSource, query: string) {
    MinecraftAPI.getMinecraftWiki(query).then(wiki => {
      if (!wiki.success) {
        source.success('未找到相关结果！');
        return;
      }
      source.success(`${wiki.title}
${wiki.desc}
${wiki.url}`);
    });
  }

  @bot.subscribe('notice-event-notify', false)
  public listenPokeMsg(bot: QQBot, msg: NotifyNoticeWSMSG): void {
    if (!msg.sub_type || msg.sub_type != 'poke') return;
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
      Bili.processMessage(bot, msg, sentMessage).then(() => {
        if (sentMessage.length > 1) {
          bot.sendGroupMsg(msg.group_id, sentMessage);
        }
      });
    });
  }

  @bot.subscribe('notice-event-group-decrease', false)
  public listenGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG): void {
    Management.handleGroupDecreaseNotice(bot, msg);
  }

  @bot.subscribe('notice-event-group-increase', false)
  public listenGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG): void {
    Management.handleGroupIncreaseNotice(bot, msg);
  }

  @bot.subscribe('request-event-group', false)
  public listenGroupRequest(bot: QQBot, msg: GroupRequestWSMSG): void {
    Management.handleGroupRequest(bot, msg);
  }

  @bot.subscribe('command-register', false)
  public cmd(bot: QQBot, command: CommandManager) {
    command.register('gugle-command', CommandManager.literal('help').execute(CustomBot.helpCommand));
    command.register('gugle-command', CommandManager.literal('mcv').execute(CustomBot.minecraftVersionCommand));
    command.register(
      'gugle-command',
      CommandManager.literal('server').then(
        CommandManager.argument('ip', Arguments.STRING)
          .execute(CustomBot.serverCommand)
          .then(CommandManager.argument('port', Arguments.NUMBER).execute(CustomBot.serverCommand))
      )
    );
    command.register(
      'gugle-command',
      CommandManager.literal('wiki').then(
        CommandManager.argument('query', Arguments.STRING).execute(CustomBot.wikiCommand)
      )
    );
  }

  @bot.cron('0/30 * * * * *')
  public cronCheckMinecraftVersion() {
    MinecraftAPI.getVersion().then(version => {
      if (!version.success) return;
      EventDataManager.getStorage('mcupdate', 'latest').then((latest: { release: string; snapshot: string }) => {
        let needWrite = true;
        if (!latest) {
          EventDataManager.setStorage('mcupdate', 'latest', version.latest).then();
          latest = version.latest;
          needWrite = false;
        }
        const msg: Message[] = [
          {
            type: 'text',
            data: {
              text: '发现新版本！\n'
            }
          }
        ];
        if (latest.release != version.latest.release) {
          msg.push({
            type: 'text',
            data: {
              text: `· 最新正式版：${version.latest.release}\n`
            }
          });
          msg.push({
            type: 'text',
            data: {
              text: `https://www.minecraft.net/en-us/article/minecraft-java-edition-${version.latest.release.replace('.', '-')}`
            }
          });
        } else if (latest.snapshot != version.latest.snapshot) {
          msg.push({
            type: 'text',
            data: {
              text: `· 最新快照版：${version.latest.snapshot}\n`
            }
          });
          let snapshot = version.latest.snapshot;
          if (snapshot.includes('pre')) {
            snapshot = snapshot.replace('pre', 'pre-release');
          } else if (snapshot.includes('rc')) {
            snapshot = snapshot.replace('rc', 'release-candidate');
          }
          snapshot = snapshot.replace('.', '-');
          msg.push({
            type: 'text',
            data: {
              text: `https://www.minecraft.net/en-us/article/minecraft-${snapshot}`
            }
          });
        } else {
          return;
        }
        if (needWrite) EventDataManager.setStorage('mcupdate', 'latest', version.latest).then();
        for (const listener of Constants.FUNCTION_MINECRAFT_GROUP) {
          bot.sendGroupMsg(listener, msg);
        }
      });
    });
  }

  @bot.cron('0/30 * * * * *')
  public cronCheckAeronauticsVersion() {
    ModrinthAPI.getAeronauticsVersion().then(version => {
      EventDataManager.getStorage('aeronautics', 'latest').then((latest: string) => {
        // If current request succeeds but previous failed, or version changed
        if (version.success && (!latest || latest !== version.latest)) {
          const msg: Message[] = [
            {
              type: 'text',
              data: {
                text: `航空学更新了！最新版本：${version.latest}`
              }
            }
          ];
          EventDataManager.setStorage('aeronautics', 'latest', version.latest).then();
          for (const listener of Constants.FUNCTION_MODRINTH_GROUP) {
            bot.sendGroupMsg(listener, msg);
          }
        }
        // If current request fails but we had a previous success, reset the storage
        else if (!version.success && latest) {
          EventDataManager.setStorage('aeronautics', 'latest', '').then();
        }
        // If first time successful, just store it
        else if (version.success && !latest) {
          EventDataManager.setStorage('aeronautics', 'latest', version.latest).then();
        }
      });
    });
  }
}

export default function run() {
  return new CustomBot();
}
