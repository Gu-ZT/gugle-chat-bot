import { EventDataManager } from '@/event';

/**
 * 版本发布的稳定确认跟踪器。
 *
 * 背景：Minecraft / Modrinth 的版本清单接口经过 CDN 缓存，且缓存刷新
 * 不是全量原子的。同一个"最新版本"可能在几次请求中反复出现/消失
 * （例如 1.21.10 → 1.21.9 → 1.21.10），导致机器人重复发送版本通知。
 *
 * 方案：不用"值变化即发送"，而是为每个候选版本记录"首次出现时间"，
 * 只有同一版本持续命中超过 STABLE_WINDOW_MS 才确认发布并发送一次；
 * 已确认的版本号永不重复发送。CDN 抖动期间消失的候选版本会被自然淘汰。
 */
export interface StableVersionTrackerState {
  /** 已确认发布并通知过的版本号（永不重复通知） */
  confirmed: string | null;
  /** 候选版本 → 首次出现时间（ISO 字符串），用于稳定窗口判断 */
  candidates: Record<string, string>;
}

/** 版本需稳定存在多久才视为确认发布（默认 24 小时） */
export const DEFAULT_STABLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 检查一个版本并返回是否需要发送通知。
 *
 * @param storageKey EventDataManager 的 storage 键（各资源独立）
 * @param version    本次请求观察到的版本号（空串表示请求失败）
 * @param stableWindowMs 稳定窗口毫秒数（默认 24 小时；测试可注入）
 * @param now        当前时间（可注入便于测试）
 * @returns true = 该版本已稳定确认且首次确认，应立即通知
 */
export async function checkStableVersion(
  storageKey: string,
  version: string,
  now: Date = new Date(),
  stableWindowMs: number = DEFAULT_STABLE_WINDOW_MS
): Promise<boolean> {
  if (!version) return false; // 请求失败/空版本不处理

  const raw = await EventDataManager.getStorage(storageKey, 'tracker');
  let tracker: StableVersionTrackerState | undefined = raw as StableVersionTrackerState | undefined;

  // 首次使用：初始化
  if (!tracker || typeof tracker !== 'object') {
    tracker = { confirmed: null, candidates: {} };
  }

  const confirmed = tracker.confirmed || null;
  const nowIso = now.toISOString();

  // 已确认过的版本：忽略（永不重复通知）
  if (version === confirmed) {
    return false;
  }

  const candidates = tracker.candidates || {};
  const firstSeen = candidates[version];

  if (firstSeen) {
    // 该版本之前出现过：判断是否达到稳定窗口
    const elapsed = now.getTime() - new Date(firstSeen).getTime();
    if (elapsed >= stableWindowMs) {
      // 稳定确认：记录 confirmed，清空候选，返回通知
      const next: StableVersionTrackerState = { confirmed: version, candidates: {} };
      await EventDataManager.setStorage(storageKey, 'tracker', next);
      return true;
    }
    // 未达窗口：保持首次出现时间不变（防止抖动重置计时）
    return false;
  }

  // 全新版本（或之前候选已被清空）：记入候选并开始计时
  const nextCandidates: Record<string, string> = { ...candidates, [version]: nowIso };
  const next: StableVersionTrackerState = { confirmed, candidates: nextCandidates };
  await EventDataManager.setStorage(storageKey, 'tracker', next);
  return false;
}