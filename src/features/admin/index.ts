import { spawn } from 'node:child_process';
import { configStoreCount, reloadAllConfigStores } from '@/config/manager';

/**
 * 管理员运维命令：/reboot、/reload、/shutdown。
 *
 * 设计要点：
 * - 仅管理员可用（QQ 侧 = management operators，Discord 侧 = 服务器管理员），
 *   权限校验由调用方（命令实现）在进入本模块前完成；
 * - `/reboot` 采用「进程内自重启」：先拉起一个脱离父进程的新实例，再优雅退出当前进程。
 *   因此不依赖外部守护进程（本仓库无 pm2/Docker/systemd 配置）；
 *   若外部同时有守护进程拉起，会短暂出现两个实例抢同一 QQ 号，需避免混用；
 * - 重启/关停前先发一条确认消息，并等待其发送完成，避免「刚回复就被杀」导致用户收不到回执；
 * - 退出前留一小段缓冲，保证 QQ 侧消息已真正发出、且日志已落盘。
 */

/** 重启/关停前的缓冲时间：给发送队列留出发送 + 日志刷盘的时间 */
const SHUTDOWN_GRACE_MS = 800;

/** 重启时用于标记「本进程由 /reboot 拉起」，避免新进程继承同名环境变量造成误判 */
const RESTART_ENV_FLAG = 'QQBOT_RESTARTED_BY_COMMAND';

export interface ReloadReport {
  /** 从磁盘重载的 ConfigStore 数量 */
  configStores: number;
  /** 是否成功重载事件数据（ban_list 等） */
  eventData: boolean;
  /** 是否成功重载 GitHub 绑定数据 */
  githubBindings: boolean;
  /** 额外重载的模块（按需由调用方追加说明） */
  extras: string[];
}

/**
 * 重载配置与数据文件（/reload）。
 *
 * 覆盖范围：
 * - 全部 ConfigStore（features/*.json、hermes.json、discord-bridge.json 等）→ 磁盘重读；
 * - 事件数据（configs/event-data.json，含 ban_list 与版本跟踪记录）；
 * - GitHub 绑定数据（configs/github-bind.json）；
 * - 由调用方传入的额外重载动作（如 PeakValleyTimer 这类构造期读配置的模块）。
 *
 * 不覆盖：bot-config.json（进程启动时读取，改端口/token 需重启）。
 */
export async function reloadRuntime(options: {
  eventData?: () => Promise<void>;
  githubBindings?: () => void;
  extra?: Array<{ name: string; run: () => void }>;
}): Promise<ReloadReport> {
  const extras: string[] = [];
  const configStores = reloadAllConfigStores();

  let eventData = false;
  try {
    await options.eventData?.();
    eventData = options.eventData !== undefined;
  } catch {
    eventData = false;
  }

  let githubBindings = false;
  try {
    options.githubBindings?.();
    githubBindings = options.githubBindings !== undefined;
  } catch {
    githubBindings = false;
  }

  for (const item of options.extra ?? []) {
    try {
      item.run();
      extras.push(item.name);
    } catch {
      // 单个模块重载失败不影响其余部分
    }
  }

  return { configStores, eventData, githubBindings, extras };
}

/** 已登记的配置仓库数量（用于 /reload 回执展示） */
export function registeredConfigStoreCount(): number {
  return configStoreCount();
}

/**
 * 进程内自重启：spawn 一个新实例后优雅退出当前进程。
 *
 * 新进程以 `detached: true` + `stdio: 'inherit'` 启动并 `unref()`，
 * 从而脱离当前进程的生命周期；主进程退出后新进程继续运行。
 *
 * @param argv 当前进程的启动参数（默认取 process.argv，保留 tsx/node 与入口路径）
 * @param delayMs 退出前的缓冲时间
 * @param onSpawned 新进程拉起后的回调（默认安排退出；测试可注入以验证而不真退出）
 * @returns 新进程 pid；spawn 失败时抛出错误（调用方据此告知用户，不做退出）
 */
export function spawnReplacementProcess(
  argv: string[] = process.argv,
  delayMs: number = SHUTDOWN_GRACE_MS,
  onSpawned: (pid: number) => void = pid => {
    // 延迟退出：给确认消息发送与日志落盘留时间
    void pid;
    setTimeout(() => process.exit(0), delayMs);
  }
): number {
  const [command, ...args] = argv;
  if (!command) throw new Error('无法获取当前启动命令，暂不能自重启');
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, [RESTART_ENV_FLAG]: '1' },
    detached: true,
    stdio: 'inherit'
  });
  child.unref();
  if (child.pid === undefined) throw new Error('新进程启动失败（未获得 pid），已取消重启');
  onSpawned(child.pid);
  return child.pid;
}

/**
 * 关闭应用：优雅停服后退出进程。
 *
 * @param stopBot 停止机器人（断开 WebSocket、触发 before-stop/after-stop）
 * @param delayMs 退出前的缓冲时间
 */
export function shutdownApplication(stopBot: () => void, delayMs: number = SHUTDOWN_GRACE_MS): void {
  try {
    stopBot();
  } finally {
    // 无论停服是否抛错都要退出，否则 /shutdown 形同虚设
    setTimeout(() => process.exit(0), delayMs);
  }
}

/** 本进程是否由 /reboot 拉起（用于启动日志标注） */
export function isRestartedByCommand(): boolean {
  return process.env[RESTART_ENV_FLAG] === '1';
}
