import fs from 'node:fs';
import path from 'node:path';

export interface ConfigFileOptions<T> {
  /** 配置文件路径（相对 process.cwd() 或绝对路径） */
  path: string;
  /** 默认值：文件不存在时写入的内容；也可用 factory 动态生成 */
  default?: T;
  /** 动态默认值工厂（优先于 default），如需要基于运行时状态生成默认配置 */
  factory?: () => T;
  /** 解析后的校验/规范化钩子：返回 false 表示内容非法（触发备份重建），返回规范化后的值 */
  normalize?: (raw: unknown) => T | null;
}

export interface ReadOrCreateResult<T> {
  /** 最终生效的数据（可能是默认值或规范化后的值） */
  data: T;
  /** 是否发生了"新建 / 备份重建 / 规范化后写回"等写盘动作 */
  wrote: boolean;
  /** 文件原本的内容损坏被备份时的备份路径；未发生则为 undefined */
  backupPath?: string;
}

const EMPTY_OBJECT = {};

/**
 * 读取 JSON 配置文件；文件不存在时用默认值创建，内容损坏时备份并重建。
 *
 * 统一了各区模块各自为政的"读取/创建/备份"逻辑：
 * - 目录不存在 → 自动创建
 * - 文件不存在 → 写入 default / factory() 生成的内容
 * - JSON 解析失败 → 备份为 `<name>.bak.<timestamp>.json` 后重建为默认内容
 * - normalize 返回 null（内容非法）→ 同样备份后重建
 * - normalize 返回合法值 → 若与原文件不同则写回（规范化落盘）
 *
 * @example
 * const { data } = readOrCreate<BotConfig>({
 *   path: 'configs/bot-config.json',
 *   factory: () => defaultBotConfig,
 *   normalize: raw => normalizeConfig(raw)
 * });
 */
export function readOrCreate<T>(options: ConfigFileOptions<T>): ReadOrCreateResult<T> {
  const configPath = path.resolve(process.cwd(), options.path);
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const factory = options.factory || (() => options.default as T);
  let wrote = false;
  let backupPath: string | undefined = undefined;

  // 文件不存在：直接创建默认内容
  if (!fs.existsSync(configPath)) {
    const created = factory();
    writeConfigFile(configPath, created);
    return { data: created, wrote: true };
  }

  const contents = fs.readFileSync(configPath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (_) {
    // JSON 损坏：备份原文件后重建默认
    backupPath = createBackupConfigFile(configPath, contents);
    const rebuilt = factory();
    writeConfigFile(configPath, rebuilt);
    return { data: rebuilt, wrote: true, backupPath };
  }

  if (options.normalize) {
    const normalized = options.normalize(raw);
    if (normalized === null) {
      // 内容非法：备份后重建默认
      backupPath = createBackupConfigFile(configPath, contents);
      const rebuilt = factory();
      writeConfigFile(configPath, rebuilt);
      return { data: rebuilt, wrote: true, backupPath };
    }
    // 规范化结果与文件不一致时写回（比如补了缺失的默认字段）
    const serialized = JSON.stringify(normalized, null, 2);
    if (serialized !== contents.trim()) {
      writeConfigFile(configPath, normalized);
      wrote = true;
    }
    return { data: normalized, wrote };
  }

  return { data: raw as T, wrote };
}

/**
 * 读取 JSON 配置文件；文件不存在返回 null，JSON 损坏抛出错误（由调用方决定如何处理）。
 */
export function readConfigFile<T>(configPath: string): T | null {
  const resolved = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(resolved)) return null;
  const contents = fs.readFileSync(resolved, 'utf8');
  try {
    return JSON.parse(contents) as T;
  } catch (error) {
    throw new Error(
      `无法解析配置文件 ${resolved}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 写入 JSON 配置文件（原子写：先写临时文件再 rename，避免写入中断损坏文件）。
 */
export function writeConfigFile<T>(configPath: string, data: T, options: { pretty?: boolean } = {}): void {
  const resolved = path.resolve(process.cwd(), configPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const serialized = options.pretty === false ? JSON.stringify(data) : `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, serialized, 'utf8');
  fs.renameSync(tempPath, resolved);
}

/**
 * 备份文件为 `<name>.bak.<timestamp>.<n>.json`，返回备份路径。
 */
export function createBackupConfigFile(configPath: string, contents: string): string {
  const resolved = path.resolve(process.cwd(), configPath);
  const { dir, ext, name } = path.parse(resolved);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backupPath = path.join(dir, `${name}.bak.${timestamp}${ext}`);
  let index = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(dir, `${name}.bak.${timestamp}.${index}${ext}`);
    index++;
  }
  fs.writeFileSync(backupPath, contents, 'utf8');
  return backupPath;
}

export { EMPTY_OBJECT };

// ---------------------------------------------------------------------------
// ConfigStore：带热重载的配置仓库
// ---------------------------------------------------------------------------

export type ConfigChangeSource = 'self' | 'file' | 'reload';

export interface ConfigStoreOptions<T> extends ConfigFileOptions<T> {
  /** 是否监听文件变化自动热重载（默认 true） */
  watch?: boolean;
  /** 文件变化触发重载的防抖毫秒数（默认 300），应对编辑器多次写入 */
  debounceMs?: number;
  /** 通过 onChange 通知时是否传入（旧值, 新值, 来源） */
  logger?: (message: string) => void;
}

export class ConfigStore<T> {
  private readonly options: ConfigStoreOptions<T>;
  private data: T;
  private readonly listeners: Array<(data: T, source: ConfigChangeSource) => void> = [];
  private watcher: fs.FSWatcher | undefined = undefined;
  private debounceTimer: NodeJS.Timeout | undefined = undefined;
  private selfWrite = false;

  public constructor(options: ConfigStoreOptions<T>) {
    this.options = options;
    const result = readOrCreate<T>(options);
    this.data = result.data;
    if (options.watch !== false) this.watch();
  }

  /** 当前生效配置（内存缓存） */
  public get(): T {
    return this.data;
  }

  /**
   * 更新配置：写入文件（原子写）→ 更新缓存 → 通知订阅者（来源 self）。
   * 通过 ConfigStore 更新的无需依赖文件 watch 事件。
   */
  public update(next: T): T {
    const resolved = path.resolve(process.cwd(), this.options.path);
    this.selfWrite = true;
    try {
      writeConfigFile(resolved, next);
    } finally {
      this.selfWrite = false;
    }
    this.data = next;
    for (const listener of this.listeners) {
      try {
        listener(next, 'self');
      } catch (error) {
        this.options.logger?.(`[config-manager] onChange(self) 回调异常: ${String(error)}`);
      }
    }
    return this.data;
  }

  /** 从磁盘重新读取配置（丢弃缓存）。文件变化时通知订阅者（来源 file / reload）。 */
  public reload(source: ConfigChangeSource = 'reload'): T {
    const result = readOrCreate<T>(this.options);
    if (!isDeepEqual(result.data, this.data)) {
      this.data = result.data;
      for (const listener of this.listeners) {
        try {
          listener(result.data, source);
        } catch (error) {
          this.options.logger?.(`[config-manager] onChange(${source}) 回调异常: ${String(error)}`);
        }
      }
    }
    return this.data;
  }

  /** 订阅配置变更（数据变化时触发）。返回取消订阅函数。 */
  public onChange(listener: (data: T, source: ConfigChangeSource) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /**
   * 监听文件变化自动热重载。
   * - 防抖：编辑器/批量工具连续写入时只在停顿后重载一次
   * - 自写抑制：update() 自己写入时标记 selfWrite，忽略随后的 change 事件
   */
  public watch(): void {
    if (this.watcher) return;
    const resolved = path.resolve(process.cwd(), this.options.path);
    const dir = path.dirname(resolved);
    const filename = path.basename(resolved);
    fs.mkdirSync(dir, { recursive: true });

    let lastReported: string | undefined = undefined;
    this.watcher = fs.watch(dir, (_event, changedFile) => {
      if (changedFile !== filename) return;
      if (this.selfWrite) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        try {
          const before = JSON.stringify(this.data);
          this.reload('file');
          const after = JSON.stringify(this.data);
          if (before !== after) {
            const reported = `${new Date().toISOString()} ${this.options.path} -> 已热重载`;
            if (reported !== lastReported) {
              lastReported = reported;
              this.options.logger?.(reported);
            }
          }
        } catch (error) {
          this.options.logger?.(`[config-manager] 热重载失败: ${String(error)}`);
        }
      }, this.options.debounceMs ?? 300);
    });
  }

  /** 停止文件监听 */
  public dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}

/** 深度比较两个 JSON 值是否相等（用于判断变更是否需要通知）。 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => isDeepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => isDeepEqual(aObj[key], bObj[key]));
  }
  return false;
}