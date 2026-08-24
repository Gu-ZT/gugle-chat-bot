import path from 'node:path';
import Constants from '@/constants';
import { readConfigFile, writeConfigFile, ConfigStore, MigrationStep } from '@/config/manager';

// ---------------------------------------------------------------------------
// 功能模块独立配置文件注册表
//
// 历史背景：所有功能的群聊/操作人白名单原先挤在 bot-config.json 的
// `function*` 字段里。现已拆分为各功能自己的配置文件（configs/features/*.json），
// 每个文件带 version 字段，未来的结构变更通过 versions/migrations 升级。
//
// 本模块职责：
//  1. 声明每个功能的独立配置文件路径、默认值、版本与迁移步骤
//  2. 提供 getFeatureConfig / getFeatureGroups 访问生效配置（ConfigStore 热重载）
//  3. 提供 migrateLegacyFunctionFields() 把 bot-config.json 里的旧 function*
//     字段一次性拆进各功能配置文件，并从 bot-config.json 移除
// ---------------------------------------------------------------------------

export interface FeatureConfig {
  version: number;
  /** 生效群聊 */
  groups: number[];
  /** 操作人白名单（如管理功能的管理员 QQ） */
  operators?: number[];
  /** 其他自定义字段（如 Bili 关注列表） */
  extra?: Record<string, unknown>;
}

export interface FeatureDefinition {
  /** 功能 id，对应 configs/features/<id>.json */
  id: string;
  /** 默认群聊 */
  defaultGroups: number[];
  /** 默认操作人白名单 */
  defaultOperators?: number[];
  /** bot-config.json 中的旧字段名（迁移用） */
  legacyGroupsFields: string[];
  /** bot-config.json 中旧操作人字段名（迁移用） */
  legacyOperatorsField?: string;
  /** 其他旧字段名 → 迁移到 extra 的键 */
  legacyExtraFields?: Record<string, string>;
  /** 当前配置版本 */
  version?: number;
  /** 迁移步骤 */
  migrations?: import('@/config/manager').MigrationStep[];
}

export interface LegacyFunctionValues {
  featureId: string;
  groups?: number[];
  operators?: number[];
  extra?: Record<string, unknown>;
}

const FEATURES_DIR = path.resolve(process.cwd(), 'configs', 'features');

// ---------------------------------------------------------------------------
// 功能定义表
// ---------------------------------------------------------------------------

export const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  {
    id: 'github',
    defaultGroups: [],
    legacyGroupsFields: ['functionGithubGroup']
  },
  {
    id: 'management',
    defaultGroups: [],
    defaultOperators: [],
    legacyGroupsFields: ['functionManagementGroup'],
    legacyOperatorsField: 'functionManagementOperator'
  },
  {
    id: 'parentheses',
    defaultGroups: [],
    legacyGroupsFields: ['functionParenthesesGroup']
  },
  {
    id: 'poke',
    defaultGroups: [],
    legacyGroupsFields: ['functionPokeGroup']
  },
  {
    id: 'minecraft',
    defaultGroups: [],
    legacyGroupsFields: ['functionMinecraftGroup']
  },
  {
    id: 'modrinth',
    defaultGroups: [],
    legacyGroupsFields: ['functionModrinthGroup']
  },
  {
    id: 'bili',
    defaultGroups: [],
    legacyGroupsFields: ['functionBiliGroup'],
    legacyExtraFields: { functionBiliFollow: 'follow' }
  },
  {
    id: 'command',
    defaultGroups: [],
    legacyGroupsFields: ['functionCommandGroup']
  }
];

// ---------------------------------------------------------------------------
// 配置仓库（ConfigStore：独立文件 + 热重载）
// ---------------------------------------------------------------------------

const stores = new Map<string, ConfigStore<FeatureConfig>>();

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isSafeInteger(item));
}

function normalizeFeatureConfig(def: FeatureDefinition, raw: unknown): FeatureConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const groups = record.groups !== undefined && isNumberArray(record.groups) ? record.groups : def.defaultGroups;
  const operators =
    record.operators !== undefined
      ? isNumberArray(record.operators)
        ? record.operators
        : def.defaultOperators
      : def.defaultOperators;
  const extra =
    record.extra !== undefined && record.extra && typeof record.extra === 'object' && !Array.isArray(record.extra)
      ? (record.extra as Record<string, unknown>)
      : undefined;
  const config: FeatureConfig = {
    version: def.version ?? 1,
    groups,
    ...(operators ? { operators } : {}),
    ...(extra ? { extra } : {})
  };
  return config;
}

function createStore(def: FeatureDefinition): ConfigStore<FeatureConfig> {
  const filePath = path.join('configs', 'features', `${def.id}.json`);
  return new ConfigStore<FeatureConfig>({
    path: filePath,
    factory: () => ({
      version: def.version ?? 1,
      groups: def.defaultGroups,
      ...(def.defaultOperators ? { operators: def.defaultOperators } : {}),
      ...(def.legacyExtraFields ? { extra: {} } : {})
    }),
    version: def.version ?? 1,
    ...(def.migrations ? { migrations: def.migrations } : {}),
    normalize: raw => normalizeFeatureConfig(def, raw)
  });
}

function getStore(def: FeatureDefinition): ConfigStore<FeatureConfig> {
  let store = stores.get(def.id);
  if (!store) {
    store = createStore(def);
    stores.set(def.id, store);
  }
  return store;
}

/** 读取功能的生效配置（自动创建默认文件 + 热重载） */
export function getFeatureConfig(defId: string): FeatureConfig {
  const def = FEATURE_DEFINITIONS.find(item => item.id === defId);
  if (!def) throw new Error(`未注册的功能配置: ${defId}`);
  return getStore(def).get();
}

/** 读取功能的生效群聊白名单 */
export function getFeatureGroups(defId: string): number[] {
  return getFeatureConfig(defId).groups;
}

/** 订阅功能配置文件变化（外部改文件自动热重载） */
export function watchFeatureConfig(defId: string, listener: (config: FeatureConfig, source: import('@/config/manager').ConfigChangeSource) => void): () => void {
  const def = FEATURE_DEFINITIONS.find(item => item.id === defId);
  if (!def) throw new Error(`未注册的功能配置: ${defId}`);
  return getStore(def).onChange(listener);
}

// ---------------------------------------------------------------------------
// 旧字段迁移：bot-config.json 的 function* → 各功能配置文件
// ---------------------------------------------------------------------------

const BOT_CONFIG_PATH = path.resolve(process.cwd(), 'configs', 'bot-config.json');

function readLegacyValues(def: FeatureDefinition, legacyRaw: Record<string, unknown>): LegacyFunctionValues | undefined {
  const groupsValue = def.legacyGroupsFields
    .map(field => legacyRaw[field])
    .find(value => value !== undefined);
  const groups = groupsValue !== undefined && isNumberArray(groupsValue) ? groupsValue : undefined;

  let operators: number[] | undefined = undefined;
  if (def.legacyOperatorsField) {
    const operatorValue = legacyRaw[def.legacyOperatorsField];
    if (operatorValue !== undefined && isNumberArray(operatorValue)) operators = operatorValue;
  }

  let extra: Record<string, unknown> | undefined = undefined;
  if (def.legacyExtraFields) {
    const extras: Record<string, unknown> = {};
    let extrasAny = false;
    for (const [legacyField, extraKey] of Object.entries(def.legacyExtraFields)) {
      const value = legacyRaw[legacyField];
      if (value !== undefined) {
        extras[extraKey] = value;
        extrasAny = true;
      }
    }
    if (extrasAny) extra = extras;
  }

  if (groups === undefined && operators === undefined && extra === undefined) return undefined;
  return {
    featureId: def.id,
    ...(groups !== undefined ? { groups } : {}),
    ...(operators !== undefined ? { operators } : {}),
    ...(extra !== undefined ? { extra } : {})
  };
}

function applyLegacyToStore(def: FeatureDefinition, legacy: LegacyFunctionValues): void {
  const store = getStore(def);
  const current = store.get();
  const next: FeatureConfig = {
    version: def.version ?? 1,
    groups: legacy.groups ?? current.groups,
    ...(legacy.operators || current.operators ? { operators: legacy.operators ?? current.operators } : {}),
    ...(legacy.extra || current.extra ? { extra: legacy.extra ?? current.extra } : {})
  };
  store.update(next);
}

/**
 * 把 bot-config.json 里的旧 `function*` 字段一次性拆进各功能配置文件。
 * 迁移完成后从 bot-config.json 删除这些字段。幂等：无旧字段时直接返回。
 */
export function migrateLegacyFunctionFields(): boolean {
  const legacyRaw = readConfigFile<Record<string, unknown>>(BOT_CONFIG_PATH);
  if (!legacyRaw) return false;

  let anyMigrated = false;
  for (const def of FEATURE_DEFINITIONS) {
    const legacy = readLegacyValues(def, legacyRaw);
    if (legacy) {
      applyLegacyToStore(def, legacy);
      anyMigrated = true;
    }
  }

  if (!anyMigrated) return false;

  // 从 bot-config.json 删除已迁移的 function* 字段并写回
  const next = { ...legacyRaw };
  for (const def of FEATURE_DEFINITIONS) {
    for (const field of def.legacyGroupsFields) delete next[field];
    if (def.legacyOperatorsField) delete next[def.legacyOperatorsField];
    if (def.legacyExtraFields) {
      for (const legacyField of Object.keys(def.legacyExtraFields)) delete next[legacyField];
    }
  }
  writeConfigFile(BOT_CONFIG_PATH, next);
  return true;
}

/** 供 ConfigStore 观察者使用的内部导出（测试用） */
export function __featureStores(): Map<string, ConfigStore<FeatureConfig>> {
  return stores;
}

export type { MigrationStep };
export { FEATURES_DIR };

// 模块加载时立即执行一次旧字段迁移：
// 保证任何功能模块首次 getFeatureConfig() 之前，bot-config.json 的
// function* 旧字段已拆入各自的 features/*.json 配置文件。
migrateLegacyFunctionFields();