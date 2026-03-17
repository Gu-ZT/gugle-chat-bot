import { bot, GroupMsgCommandSource, QQBot } from '@/index';
import { GroupMessageWSMSG, Message, PokeNoticeWSMSG } from '@/type';
import { ParenthesesMatching } from '@/features/parentheses';
import { Github } from '@/features/github';
import { Poke } from '@/features/poke';
import { Arguments, CommandManager, CommandSource } from 'gugle-command';
import { MinecraftAPI } from '@/features/minecraft';
import { EventDataManager } from '@/event';
import Constants from '@/constants';
import { Bili } from '@/features/bili';

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
      Bili.processMessage(bot, msg, sentMessage).then(() => {
        if (sentMessage.length > 1) {
          bot.sendGroupMsg(msg.group_id, sentMessage);
        }
      });
    });
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
          msg.push({
            type: 'text',
            data: {
              text: `https://www.minecraft.net/en-us/article/minecraft-${version.latest.snapshot.replace('.', '-')}`
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
}

export default function run() {
  return new CustomBot();
}
