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
import { isBotCommandSource } from '@/command';
import { MinecraftAPI } from '@/features/minecraft';
import { ModrinthAPI } from '@/features/modrinth';
import {
  getFeatureGroups,
  isValidRepositoryName,
  isValidRepositoryOwner,
  subscribeGithubRepository
} from '@/config/features';
import { addGithubAllowedRepository, isGithubAllowedPattern } from '@/config';
import { checkReleasedVersion } from '@/features/version-tracker';
import { Bili } from '@/features/bili';
import { Management } from '@/features/management';
import { Welcome } from '@/features/welcome';
import { PeakValleyTimer } from '@/features/peak-valley-timer';
import { DiscordBridge } from '@/features/discord-bridge';

class CustomBot {
  private static readonly peakValleyTimer: PeakValleyTimer = PeakValleyTimer.getInstance();

  public static helpCommand(source: CommandSource) {
    source.success(`帮助
· /mcv：获取 Minecraft 版本信息
· /server <ip> <port?>：获取 Minecraft 服务器状态
· /wiki <query>：搜索 Minecraft 维基
· /github bind <Username>：绑定 GitHub 用户名
· /github subscribe <owner/repo>：订阅仓库消息推送
· /github allow <owner|owner/repo>：授权仓库访问（管理员）
· /pardon <QQ号>：把用户移出黑名单（管理员）
· /send <msg> [group|channel]：向互通的 Discord 频道/QQ 群发送消息（不填目标时发送到第一个互通条目的对端）
· /pvtime：查询当前是梁文峰时间还是梁文谷时间
以上命令均可在互通的 Discord 频道中使用（/ 或 ! 前缀），回复发在 Discord 频道`);
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
    if (!isBotCommandSource(source)) {
      source.fail('GitHub 绑定仅支持在群聊或互通频道中使用');
      return;
    }

    GitHubBindingManager.bind(source.getUserId(), username)
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
    if (!isBotCommandSource(source)) {
      source.fail('GitHub 订阅仅支持在群聊或互通频道中使用');
      return;
    }
    if (!isValidRepositoryName(repository)) {
      source.fail(`仓库名格式错误：${repository}\n应为 owner/repo，例如 Anvil-Dev/AnvilCraft`);
      return;
    }
    const groupId = source.getGroupId();
    if (groupId === undefined) {
      source.fail('当前频道未绑定互通 QQ 群，无法订阅');
      return;
    }
    // 与消息查询同一套判定：owner 已绑定 GitHub 账号，或命中允许列表配置
    let allowedText = '';
    if (!Github.isAllowedRepository(repository)) {
      if (!source.isAdmin()) {
        source.fail(
          `仓库 ${repository} 不在允许访问的仓库列表中，无法订阅\n` +
            `如这是你自己的仓库，可先用 /github bind <用户名> 绑定 GitHub 账号，或联系管理员添加`
        );
        return;
      }
      // 管理员可自助开白：把该 owner 加入允许列表后继续订阅
      const owner = repository.split('/')[0]!;
      addGithubAllowedRepository(owner);
      allowedText = `· 已自动将 ${owner} 加入允许访问的仓库列表\n`;
    }
    const subscribers = subscribeGithubRepository(repository, groupId);
    const current = subscribers.includes(groupId) ? `已订阅仓库 ${repository} 的消息推送` : `订阅失败，请重试`;
    source.success(
      `${current}
· 当前订阅该仓库的群：${subscribers.length > 0 ? subscribers.join('、') : '（无）'}
${allowedText}· 若该仓库尚未配置 webhook，请在仓库页面 Settings → Webhooks → Add webhook 添加：
  · Payload URL：https://hook.example.com
  · Content type：application/json
  · Secret：留空
  · Which events would you like to trigger this webhook?：Send me everything.`
    );
  }

  /**
   * /github allow <owner|owner/repo>：把 GitHub owner 或仓库加入允许访问列表（管理员）。
   * 传入 owner 时授权其下全部仓库，传入 owner/repo 时只授权该仓库。
   */
  public static githubAllowCommand(source: CommandSource, target: string) {
    if (!isBotCommandSource(source)) {
      source.fail('GitHub allow 仅支持在群聊或互通频道中使用');
      return;
    }
    if (!source.isAdmin()) {
      source.fail('该命令仅限管理员使用');
      return;
    }
    const repositoryTarget = target.includes('/');
    if (repositoryTarget ? !isValidRepositoryName(target) : !isValidRepositoryOwner(target)) {
      source.fail(
        `目标格式错误：${target}\n` +
          `应为 owner（授权其下全部仓库，如 Anvil-Dev）或 owner/repo（仅授权该仓库，如 Anvil-Dev/AnvilCraft）`
      );
      return;
    }
    const existed = isGithubAllowedPattern(target);
    const pattern = addGithubAllowedRepository(target);
    if (existed) {
      source.success(`${pattern} 已在允许访问的仓库列表中`);
      return;
    }
    source.success(
      repositoryTarget
        ? `已将仓库 ${pattern} 加入允许访问的仓库列表`
        : `已将 ${pattern} 加入允许访问的仓库列表，其下全部仓库均可访问`
    );
  }

  public static pardonCommand(source: CommandSource, userId: string) {
    if (!isBotCommandSource(source)) {
      source.fail('只支持在群聊或互通频道中使用');
      return;
    }
    const groupId = source.getGroupId();
    if (groupId === undefined) {
      source.fail('当前频道未绑定互通 QQ 群，无法赦免');
      return;
    }
    const qq = Number(userId);
    if (!Number.isSafeInteger(qq) || qq <= 0) {
      source.fail(`QQ 号格式错误：${userId}`);
      return;
    }
    // QQ 侧传 QQ 号（Management 内部再校验 operators 白名单）；
    // Discord 侧传 dc:<用户ID>（服务器管理员身份已由命令源层校验）
    const operatorId = source instanceof GroupMsgCommandSource ? source.msg.sender.user_id : source.getUserId();
    Management.pardon(groupId, operatorId, qq)
      .then(removed => {
        if (removed) {
          source.success(`已从黑名单中移除用户 ${qq}`);
        } else {
          source.fail('用户不在黑名单中，或你没有赦免权限');
        }
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
    // 各处理器失败只记录日志：既不能产生未处理的 rejection（会终止进程），
    // 也不能中断后续处理器与最终的消息发送
    Github.processMessage(bot, msg, sentMessage)
      .catch(e => {
        bot.logger?.error(`Github message process failed: ${e?.message ?? e}`);
      })
      .then(() => Bili.processMessage(bot, msg, sentMessage))
      .catch(e => {
        bot.logger?.error(`Bili message process failed: ${e?.message ?? e}`);
      })
      .then(() => {
        if (sentMessage.length > 1) {
          bot.sendGroupMsg(msg.group_id, sentMessage);
        }
      });
  }

  @bot.subscribe('message-event-group', false)
  public listenDiscordBridgeMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    // QQ ⇄ Discord 互通：转发与 /send 分发（不依赖 command 白名单，内部自行门控）
    DiscordBridge.getInstance().handleQQMessage(bot, msg);
  }

  @bot.subscribe('notice-event-group-decrease', false)
  public listenGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG): void {
    Management.handleGroupDecreaseNotice(bot, msg);
  }

  @bot.subscribe('notice-event-group-increase', false)
  public listenGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG): void {
    Management.handleGroupIncreaseNotice(bot, msg);
    Welcome.handleGroupIncreaseNotice(bot, msg);
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
      CommandManager.literal('github')
        .then(
          CommandManager.literal('bind').then(
            CommandManager.argument('username', Arguments.STRING).execute(CustomBot.githubBindCommand)
          )
        )
        .then(
          CommandManager.literal('subscribe').then(
            CommandManager.argument('repository', Arguments.STRING).execute(CustomBot.githubSubscribeCommand)
          )
        )
        .then(
          CommandManager.literal('allow').then(
            CommandManager.argument('target', Arguments.STRING).execute(CustomBot.githubAllowCommand)
          )
        )
    );
    command.register(
      'gugle-command',
      CommandManager.literal('pardon').then(
        CommandManager.argument('userId', Arguments.STRING).execute(CustomBot.pardonCommand)
      )
    );
    command.register('gugle-command', CommandManager.literal('pvtime').execute(CustomBot.peakValleyTimeCommand));
  }

  @bot.subscribe('after-start', false)
  public startPeakValleyTimer(bot: QQBot): void {
    CustomBot.peakValleyTimer.start(bot);
    DiscordBridge.getInstance().start(bot);
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
