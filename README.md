<div align="center">

# gugle-chat-bot

**A modular QQ group chat bot with Discord bridging, GitHub integration, and AI conversation.**

English | [简体中文](README.zh_CN.md)

</div>

## Overview

gugle-chat-bot is a TypeScript chat bot for QQ groups, built on the OneBot protocol (HTTP + WebSocket). It connects to a OneBot implementation (such as NapCat or Lagrange) and provides group utilities, GitHub webhook notifications, a two-way Discord bridge, and AI conversations powered by a Hermes Agent. Every feature is a self-contained module with its own hot-reloaded configuration file.

## Features

- **GitHub integration** — receives webhook events and pushes issue / PR / release notifications to subscribed groups; renders `#123`-style issue references as rich links; `/github` commands with an owner allowlist.
- **Discord bridge** — two-way message relay between QQ groups and Discord channels, including image/attachment forwarding, bot message relay, reply mapping, and the `/send` command.
- **AI conversation (Hermes)** — chat with a Hermes Agent from QQ groups or Discord channels with shared session context; system prompt is read from `configs/SOUL.md` and can be edited without a restart.
- **Group management** — blacklist management, join-request handling, and the `/pardon` command for operators.
- **Welcome messages** — per-group configurable welcome texts for new members.
- **Bilibili subscription** — push updates for followed Bilibili uploaders.
- **Minecraft utilities** — `/mcv` version lookup, `/server` status query, and `/wiki` search.
- **Modrinth version tracking** — watches Maven/Modrinth releases and announces new versions.
- **Parentheses matching** — auto-completes missing closing brackets in group messages.
- **Peak-valley timer** — scheduled peak/off-peak electricity price reminders (`/pvtime`).
- **Poke** — responds to QQ poke (戳一戳) interactions.
- **Rich image rendering** — renders Markdown and pages to images with Puppeteer and markdown-it.
- **Version tracker** — monotonic timestamp tracking that avoids duplicate release notifications caused by CDN cache jitter.

## Commands

| Command | Description |
| --- | --- |
| `/help` | Show the command list |
| `/mcv` | Query the latest Minecraft versions |
| `/server` | Query Minecraft server status |
| `/wiki` | Search the Minecraft Wiki |
| `/github bind` | Bind a group to a GitHub repository |
| `/github subscribe <owner/repo>` | Subscribe the group to repository events |
| `/github allow <owner\|owner/repo>` | Add an owner or repository to the allowlist (operators) |
| `/pardon <QQ>` | Remove a user from the blacklist (operators) |
| `/pvtime` | Show peak/off-peak electricity price times |
| `/send` | Forward a message across the Discord bridge |

## Tech Stack

- **Runtime**: Node.js + TypeScript, pnpm
- **Protocol**: OneBot (HTTP + WebSocket via `ws` and `axios`)
- **Framework**: `gugle-command` (command tree) + `gugle-event` (event bus)
- **Discord**: discord.js v14
- **Rendering**: Puppeteer, markdown-it, highlight.js, jsdom
- **Scheduling & logging**: node-cron, winston (daily rotate file)

## Requirements

- Node.js 18+ and pnpm 10
- A OneBot implementation (e.g. NapCat, Lagrange.OneBot) with HTTP and WebSocket endpoints
- Google Chrome / Chromium (for image rendering)
- Optional: a Discord bot token (Discord bridge), a Hermes Agent endpoint (AI conversation)

## Quick Start

```bash
git clone https://github.com/Gu-ZT/gugle-chat-bot.git
cd gugle-chat-bot
pnpm install
```

Create the main configuration file `configs/bot-config.json` (all fields optional, shown with their meanings):

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

Then start the bot:

```bash
pnpm run dev     # watch mode (nodemon + tsx)
pnpm run build   # compile to dist/
```

## Configuration

All configuration lives in the gitignored `configs/` directory and is hot-reloaded:

- `configs/bot-config.json` — core bot settings (OneBot endpoints, access tokens, GitHub webhook port, log level, Chrome path).
- `configs/features/<id>.json` — one file per feature, e.g. `github.json`, `discord-bridge.json`, `hermes.json`, `welcome.json`, `management.json`. Older formats are migrated automatically on load.
- `configs/SOUL.md` — system prompt for AI conversation; overrides `systemPrompt` in `hermes.json` and can be edited without a restart.

Administrators are defined once in the `operators` array of `configs/features/management.json` and shared by every feature.

To receive GitHub webhooks, add a webhook in the repository settings pointing to the bot's `githubPort`:

- **Payload URL**: `https://<your-domain>`
- **Content type**: `application/json`
- **Secret**: leave empty
- **Events**: Send me everything

## Project Structure

```
src/
├── command/      # command source abstraction over gugle-command
├── config/       # typed config manager and per-feature config stores
├── constants/    # default constants
├── event/        # event data manager
├── features/     # self-contained feature modules
│   ├── bili/            # Bilibili subscription
│   ├── discord-bridge/  # QQ ↔ Discord relay
│   ├── github/          # webhook receiver and subscriptions
│   ├── hermes/          # AI conversation bridge
│   ├── management/      # blacklist and join requests
│   ├── minecraft/       # version / server / wiki queries
│   ├── modrinth/        # Modrinth release tracking
│   ├── parentheses/     # bracket auto-completion
│   ├── peak-valley-timer/
│   ├── poke/
│   ├── version-tracker/
│   └── welcome/
├── image/        # Puppeteer-based rendering (serial queue, shared Chrome)
├── logger/       # winston daily-rotate-file logging
└── type/         # OneBot message types
```

## License

ISC
