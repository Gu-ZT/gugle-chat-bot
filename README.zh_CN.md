<div align="center">

# gugle-chat-bot

**模块化的 QQ 群聊机器人，支持 Discord 互通、GitHub 集成与 AI 对话。**

[English](README.md) | 简体中文

</div>

## 简介

gugle-chat-bot 是一个基于 OneBot 协议（HTTP + WebSocket）的 TypeScript QQ 群聊机器人。它连接 OneBot 实现（如 NapCat、Lagrange），提供群聊工具、GitHub webhook 通知、QQ 与 Discord 双向互通，以及由 Hermes Agent 驱动的 AI 对话。每个功能都是独立模块，拥有各自的热重载配置文件。

## 功能特性

- **GitHub 集成** — 接收 webhook 事件，向已订阅的群推送 issue / PR / release 通知；将 `#123` 形式的 issue 引用渲染为富文本链接；提供 `/github` 系列命令与 owner 白名单。
- **Discord 互通桥** — QQ 群与 Discord 频道双向消息互通，支持图片/附件转发、机器人消息互通、回复映射与 `/send` 命令。
- **AI 对话（Hermes）** — 在 QQ 群或 Discord 频道中与 Hermes Agent 对话，共享会话上下文；系统提示词读取 `configs/SOUL.md`，编辑后免重启生效。
- **群管理** — 黑名单管理、入群请求处理，以及供管理员使用的 `/pardon` 赦免命令。
- **新人欢迎** — 支持按群配置的新成员欢迎语。
- **B 站订阅** — 推送已关注 UP 主的更新动态。
- **Minecraft 工具** — `/mcv` 版本查询、`/server` 服务器状态查询、`/wiki` 词条搜索。
- **Modrinth 版本跟踪** — 监控 Maven/Modrinth 发布并通知新版本。
- **括号匹配** — 自动补全群消息中缺失的右括号。
- **峰谷电价定时** — 定时推送峰谷电价提醒（`/pvtime`）。
- **戳一戳** — 响应 QQ 戳一戳互动。
- **富文本图片渲染** — 使用 Puppeteer 与 markdown-it 将 Markdown 和页面渲染为图片。
- **版本跟踪** — 基于时间戳单调性的跟踪器，避免 CDN 缓存抖动导致的重复通知。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示命令列表 |
| `/mcv` | 查询最新的 Minecraft 版本 |
| `/server` | 查询 Minecraft 服务器状态 |
| `/wiki` | 搜索 Minecraft Wiki |
| `/github bind` | 将群绑定到 GitHub 仓库 |
| `/github subscribe <owner/repo>` | 订阅仓库事件推送到本群 |
| `/github allow <owner\|owner/repo>` | 将 owner 或仓库加入允许列表（管理员） |
| `/pardon <QQ>` | 将用户从黑名单中赦免（管理员） |
| `/pvtime` | 查看峰谷电价时间 |
| `/send` | 通过 Discord 互通桥转发消息 |

## 技术栈

- **运行时**：Node.js + TypeScript，pnpm
- **协议**：OneBot（基于 `ws` 与 `axios` 的 HTTP + WebSocket）
- **框架**：`gugle-command`（命令树）+ `gugle-event`（事件总线）
- **Discord**：discord.js v14
- **渲染**：Puppeteer、markdown-it、highlight.js、jsdom
- **调度与日志**：node-cron、winston（每日滚动文件）

## 环境要求

- Node.js 18+ 与 pnpm 10
- 一个 OneBot 实现（如 NapCat、Lagrange.OneBot），需开启 HTTP 与 WebSocket 端点
- Google Chrome / Chromium（用于图片渲染）
- 可选：Discord 机器人 token（Discord 互通）、Hermes Agent 端点（AI 对话）

## 快速开始

```bash
git clone https://github.com/Gu-ZT/gugle-chat-bot.git
cd gugle-chat-bot
pnpm install
```

创建主配置文件 `configs/bot-config.json`（所有字段均可选，注释说明其含义）：

```json
{
  "httpUrl": "http://127.0.0.1:3000",
  "wsUrl": "ws://127.0.0.1:3001",
  "wsToken": "",
  "httpToken": "",
  "githubPort": 8848,
  "githubAllowedRepositories": ["Your-Org/*"],
  "logLevel": "info",
  "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
}
```

然后启动机器人：

```bash
pnpm run dev     # 监听模式（nodemon + tsx）
pnpm run build   # 编译到 dist/
```

## 配置

所有配置位于已被 gitignore 的 `configs/` 目录，均支持热重载：

- `configs/bot-config.json` — 核心配置（OneBot 端点、访问令牌、GitHub webhook 端口、日志级别、Chrome 路径）。
- `configs/features/<id>.json` — 每个功能一个文件，如 `github.json`、`discord-bridge.json`、`hermes.json`、`welcome.json`、`management.json`。旧版本格式会在加载时自动迁移。
- `configs/SOUL.md` — AI 对话的系统提示词；优先级高于 `hermes.json` 中的 `systemPrompt`，编辑后免重启生效。

管理员只需在 `configs/features/management.json` 的 `operators` 数组中定义一次，全项目各功能共享。

如需接收 GitHub webhook，请在仓库设置中添加 webhook，指向机器人的 `githubPort`：

- **Payload URL**：`https://<你的域名>`
- **Content type**：`application/json`
- **Secret**：留空
- **Events**：Send me everything

## 项目结构

```
src/
├── command/      # 基于 gugle-command 的命令源抽象
├── config/       # 类型化配置管理与各功能配置存储
├── constants/    # 默认常量
├── event/        # 事件数据管理
├── features/     # 独立功能模块
│   ├── bili/            # B 站订阅
│   ├── discord-bridge/  # QQ ↔ Discord 互通
│   ├── github/          # webhook 接收与订阅
│   ├── hermes/          # AI 对话桥
│   ├── management/      # 黑名单与入群请求
│   ├── minecraft/       # 版本 / 服务器 / Wiki 查询
│   ├── modrinth/        # Modrinth 发布跟踪
│   ├── parentheses/     # 括号自动补全
│   ├── peak-valley-timer/
│   ├── poke/
│   ├── version-tracker/
│   └── welcome/
├── image/        # 基于 Puppeteer 的渲染（串行队列，复用 Chrome）
├── logger/       # winston 每日滚动日志
└── type/         # OneBot 消息类型
```

## 许可证

ISC
