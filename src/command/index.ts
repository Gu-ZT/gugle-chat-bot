import { CommandSource } from 'gugle-command';

/**
 * 平台无关的命令源抽象。
 *
 * 背景：`gugle-command` 的 `CommandSource` 只有 success/fail/getName/hasPermission 四个方法，
 * 命令实现若直接 `instanceof GroupMsgCommandSource` 判定，就只能服务 QQ 群消息。
 * 这里扩展出跨平台需要的最小能力集，让同一套命令实现既能在 QQ 群、也能在 Discord 频道执行。
 */
export interface BotCommandSource extends CommandSource {
  /**
   * 调用者平台内唯一标识：
   * - QQ 群消息：纯数字 QQ 号字符串（如 `2308465862`）
   * - Discord 消息：`dc:<用户ID>`（如 `dc:123456789012345678`）
   *
   * 用于 GitHub 绑定等需要持久化用户身份的场景；`dc:` 前缀保证与纯数字 QQ 号不会冲突。
   */
  getUserId(): string;

  /**
   * 消息所在群/频道在当前平台上对应的互通 QQ 群号。
   * QQ 群消息返回自身群号；Discord 频道返回该频道桥接配置里的 QQ 群号；
   * 无归属群（未配置互通的 Discord 频道等）返回 undefined。
   */
  getGroupId(): number | undefined;

  /**
   * 是否为管理员：QQ 侧复用 management operators 白名单；
   * Discord 侧为服务器拥有者或拥有管理服务器/管理员权限者。
   */
  isAdmin(): boolean;
}

/** 判断命令源是否具备 BotCommandSource 能力（鸭子类型，跨模块实例也成立） */
export function isBotCommandSource(source: CommandSource | undefined): source is BotCommandSource {
  if (!source) return false;
  const candidate = source as Partial<BotCommandSource>;
  return (
    typeof candidate.getUserId === 'function' &&
    typeof candidate.getGroupId === 'function' &&
    typeof candidate.isAdmin === 'function'
  );
}

/**
 * 把命令文本规范化为 gugle-command 可执行的形式。
 *
 * gugle-command 固定使用 `/` 前缀；Discord 客户端会把以 `/` 开头的内容当作斜杠命令输入，
 * 因此 Discord 侧额外支持 `!` 前缀作为兜底，统一在这里转换。
 */
export function normalizeCommandText(text: string): string {
  return text.startsWith('!') ? `/${text.slice(1)}` : text;
}
