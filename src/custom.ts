import { bot, GroupMsgCommandSource, QQBot } from '@/index';
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
import { getFeatureGroups, isValidRepositoryName, subscribeGithubRepository } from '@/config/features';
import { checkReleasedVersion } from '@/features/version-tracker';
import { Bili } from '@/features/bili';
import { Management } from '@/features/management';
import { PeakValleyTimer } from '@/features/peak-valley-timer';

class CustomBot {
  private static readonly peakValleyTimer: PeakValleyTimer = PeakValleyTimer.getInstance();

  public static helpCommand(source: CommandSource) {
    source.success(`帮助
· /mcv：获取 Minecraft 版本信息
· /server <ip> <port?>：获取 Minecraft 服务器状态
· /wiki <query>：搜索 Minecraft 维基
· /github bind <Username>：绑定 GitHub 用户名
· /github subscribe <owner/repo>：订阅仓库消息推送
· /pvtime：查询当前是梁文峰时间还是梁文谷时间`);
  }

  public static peakValleyTimeCommand(source: CommandSource) {
    source.success(CustomBot.peakValleyTimer.getCommandMessage());
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

  public static githubSubscribeCommand(source: CommandSource, repository: string) {
    if (!(source instanceof GroupMsgCommandSource)) {
      source.fail('GitHub 订阅仅支持在群聊中使用');
      return;
    }
    if (!isValidRepositoryName(repository)) {
      source.fail(`仓库名格式错误：${repository}\n应为 owner/repo，例如 Anvil-Dev/AnvilCraft`);
      return;
    }
    const subscribers = subscribeGithubRepository(repository, source.msg.group_id);
    const current = subscribers.includes(source.msg.group_id)
      ? `已订阅仓库 ${repository} 的消息推送`
      : `订阅失败，请重试`;
    source.success(
      `${current}
· 当前订阅该仓库的群：${subscribers.length > 0 ? subscribers.join('、') : '（无）'}`
    );
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
    const githubNode = CommandManager.literal('github');
    githubNode.then(
      CommandManager.literal('bind').then(
        CommandManager.argument('username', Arguments.STRING).execute(CustomBot.githubBindCommand)
      )
    );
    githubNode.then(
      CommandManager.literal('subscribe').then(
        CommandManager.argument('repository', Arguments.STRING).execute(CustomBot.githubSubscribeCommand)
      )
    );
    command.register('gugle-command', githubNode);
    command.register('gugle-command', CommandManager.literal('pvtime').execute(CustomBot.peakValleyTimeCommand));
  }

  @bot.subscribe('after-start', false)
  public startPeakValleyTimer(bot: QQBot): void {
    CustomBot.peakValleyTimer.start(bot);
  }

  @bot.cron('0/30 * * * * *')
  public cronCheckMinecraftVersion() {
    MinecraftAPI.getVersion().then(version => {
      if (!version.success) return;
      // 从 manifest 中按 id 查找 release / snapshot 的权威 releaseTime，
      // 用时间戳单调性判断新发布，避免 CDN 缓存抖动重复发送
      const releaseId = version.latest.release;
      const snapshotId = version.latest.snapshot;
      const releaseTime = version.versions.find(v => v.id === releaseId)?.releaseTime || '';
      const snapshotTime = version.versions.find(v => v.id === snapshotId)?.releaseTime || '';
      Promise.all([
        checkReleasedVersion('mcupdate:release', releaseId, Date.parse(releaseTime) || 0),
        checkReleasedVersion('mcupdate:snapshot', snapshotId, Date.parse(snapshotTime) || 0)
      ]).then(([releaseNew, snapshotNew]) => {
        const msg: Message[] = [
          {
            type: 'text',
            data: {
              text: '发现新版本！\n'
            }
          }
        ];
        if (releaseNew) {
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
        }
        if (snapshotNew) {
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
        }
        // 只有 release 或 snapshot 任一被确认为新发布才发送
        if (!releaseNew && !snapshotNew) return;
        for (const listener of getFeatureGroups('minecraft')) {
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
