import fs from 'node:fs';
import path from 'node:path';
import Constants from '@/constants';

export type LogLevel = 'info' | 'error' | 'warn' | 'debug';

export interface BotConfig {
  userAgent: string;
  logLevel: LogLevel;
  chromePath: string;
  httpUrl: string;
  wsUrl: string;
  tokenParams: string;
  wsToken: string;
  httpToken: string;
  githubPort: number;
  functionCommandGroup: number[];
  functionGithubGroup: number[];
  functionManagementGroup: number[];
  functionManagementOperator: number[];
  functionParenthesesGroup: number[];
  functionPokeGroup: number[];
  functionMinecraftGroup: number[];
  functionModrinthGroup: number[];
  functionBiliFollow: number[];
  functionBiliGroup: number[];
}

type ConfigFile = Partial<BotConfig>;

const defaultBotConfig: BotConfig = {
  userAgent: Constants.USER_AGENT,
  logLevel: Constants.LOG_LEVEL,
  chromePath: Constants.CHROME_PATH,
  httpUrl: Constants.HTTP_URL,
  wsUrl: Constants.WS_URL,
  tokenParams: Constants.TOKEN_PARAMS,
  wsToken: Constants.WS_TOKEN,
  httpToken: Constants.HTTP_TOKEN,
  githubPort: Constants.GITHUB_PORT,
  functionCommandGroup: Constants.FUNCTION_COMMAND_GROUP,
  functionGithubGroup: Constants.FUNCTION_GITHUB_GROUP,
  functionManagementGroup: Constants.FUNCTION_MANAGEMENT_GROUP,
  functionManagementOperator: Constants.FUNCTION_MANAGEMENT_OPERATOR,
  functionParenthesesGroup: Constants.FUNCTION_PARENTHESES_GROUP,
  functionPokeGroup: Constants.FUNCTION_POKE_GROUP,
  functionMinecraftGroup: Constants.FUNCTION_MINECRAFT_GROUP,
  functionModrinthGroup: Constants.FUNCTION_MODRINTH_GROUP,
  functionBiliFollow: Constants.FUNCTION_BILI_FOLLOW,
  functionBiliGroup: Constants.FUNCTION_BILI_GROUP
};

const logLevels: readonly LogLevel[] = ['info', 'error', 'warn', 'debug'];

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isLogLevel(value: unknown): value is LogLevel {
  return isString(value) && logLevels.includes(value as LogLevel);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isSafeInteger(item));
}

function readConfigFile(configPath: string): ConfigFile {
  if (!fs.existsSync(configPath)) return {};

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('root must be an object');
    }
    return config as ConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load bot configuration from ${configPath}: ${message}`);
  }
}

function valueOrDefault<T>(value: unknown, validator: (value: unknown) => value is T, fallback: T): T {
  return validator(value) ? value : fallback;
}

export function loadBotConfig(configPath: string = path.resolve(process.cwd(), 'configs', 'bot-config.json')): BotConfig {
  const config = readConfigFile(configPath);

  return {
    userAgent: valueOrDefault(config.userAgent, isString, defaultBotConfig.userAgent),
    logLevel: valueOrDefault(config.logLevel, isLogLevel, defaultBotConfig.logLevel),
    chromePath: valueOrDefault(config.chromePath, isString, defaultBotConfig.chromePath),
    httpUrl: valueOrDefault(config.httpUrl, isString, defaultBotConfig.httpUrl),
    wsUrl: valueOrDefault(config.wsUrl, isString, defaultBotConfig.wsUrl),
    tokenParams: valueOrDefault(config.tokenParams, isString, defaultBotConfig.tokenParams),
    wsToken: valueOrDefault(config.wsToken, isString, defaultBotConfig.wsToken),
    httpToken: valueOrDefault(config.httpToken, isString, defaultBotConfig.httpToken),
    githubPort: valueOrDefault(config.githubPort, isPort, defaultBotConfig.githubPort),
    functionCommandGroup: valueOrDefault(config.functionCommandGroup, isNumberArray, defaultBotConfig.functionCommandGroup),
    functionGithubGroup: valueOrDefault(config.functionGithubGroup, isNumberArray, defaultBotConfig.functionGithubGroup),
    functionManagementGroup: valueOrDefault(
      config.functionManagementGroup,
      isNumberArray,
      defaultBotConfig.functionManagementGroup
    ),
    functionManagementOperator: valueOrDefault(
      config.functionManagementOperator,
      isNumberArray,
      defaultBotConfig.functionManagementOperator
    ),
    functionParenthesesGroup: valueOrDefault(
      config.functionParenthesesGroup,
      isNumberArray,
      defaultBotConfig.functionParenthesesGroup
    ),
    functionPokeGroup: valueOrDefault(config.functionPokeGroup, isNumberArray, defaultBotConfig.functionPokeGroup),
    functionMinecraftGroup: valueOrDefault(
      config.functionMinecraftGroup,
      isNumberArray,
      defaultBotConfig.functionMinecraftGroup
    ),
    functionModrinthGroup: valueOrDefault(
      config.functionModrinthGroup,
      isNumberArray,
      defaultBotConfig.functionModrinthGroup
    ),
    functionBiliFollow: valueOrDefault(config.functionBiliFollow, isNumberArray, defaultBotConfig.functionBiliFollow),
    functionBiliGroup: valueOrDefault(config.functionBiliGroup, isNumberArray, defaultBotConfig.functionBiliGroup)
  };
}

export const botConfig = loadBotConfig();
