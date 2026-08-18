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
import { GitHubBindingManager } from '@/features/github/binding';
import { Poke } from '@/features/poke';
import { Arguments, CommandManager, CommandSource } from 'gugle-command';
import { MinecraftAPI } from '@/features/minecraft';
import { ModrinthAPI } from '@/features/modrinth';
import { EventDataManager } from '@/event';
import { botConfig } from '@/config';
import { Bili } from '@/features/bili';
import { Management } from '@/features/management';

class CustomBot {
  public static helpCommand(source: CommandSource) {
    source.success(`帮助
· /mcv：获取 Minecraft 版本信息
· /server <ip> <port?>：获取 Minecraft 服务器状态
· /wiki <query>：搜索 Minecraft 维基
· /github bind <Username>：绑定 GitHub 用户名`);
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

  public static githubBindCommand(source: CommandSource, username: string) {
    if (!(source instanceof GroupMsgCommandSource)) {
      source.fail('GitHub 绑定仅支持在群聊中使用');
      return;
    }

    GitHubBindingManager.bind(source.msg.sender.user_id, username)
      .then(result => {
        if (result.state === 'bound') {
          source.success(`GitHub 用户 ${username} 绑定成功`);
          return;
        }
        source.success(`请在 GitHub 用户 ${username} 的 Bio 中添加验证码：${result.code}\n添加后再次执行 /github bind ${username}`);
      })
      .catch(error => {
        source.fail(error instanceof Error ? error.message : String(error));
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
    command.register(
      'gugle-command',
      CommandManager.literal('github').then(
        CommandManager.literal('bind').then(
          CommandManager.argument('username', Arguments.STRING).execute(CustomBot.githubBindCommand)
        )
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
        for (const listener of botConfig.functionMinecraftGroup) {
          bot.sendGroupMsg(listener, msg);
        }
      });
    });
  }

  // @bot.cron('0/30 * * * * *')
  // public cronCheckAeronauticsVersion() {
  //   ModrinthAPI.checkVersion(bot, 'create-aeronautics', '航空学');
  // }
}

export default function run() {
  return new CustomBot();
}
