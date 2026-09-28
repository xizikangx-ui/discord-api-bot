# Discord Privileged Intent Review Notes

This document describes the current code in this repository. Keep it accurate if the bot's features change.

## Current intent audit

| Intent | Enabled in code | Needed | Reason |
|---|---:|---:|---|
| Guild Members / Server Members Intent | Yes (`GatewayIntentBits.GuildMembers`) | Yes, for configured roster features | Fetch the members holding administrator-selected management roles, and track role/member changes to maintain the roster and appointment history. |
| Message Content Intent | No | No | The bot uses slash commands, buttons, select menus, and modals. It has no `messageCreate` listener and does not scan ordinary server messages. |
| Guild Presences / Presence Intent | No | No | No online status, activity, or presence feature exists. |

The project currently constructs the Discord client with `Guilds` and `GuildMembers` only. Do not claim a need for Message Content or Presence access based on this code.

## Paste-ready application text: Server Members Intent

### English

> This bot uses the Server Members (Guild Members) intent for its opt-in management roster feature. A server administrator configures the specific management role or roles through the bot's in-server panel. When the roster is initialized or refreshed, the bot fetches guild members, filters them to members holding only those configured roles, and excludes bot accounts. It records the member ID and appointment start/end timestamps so it can publish the current roster and appointment/resignation notices. The bot also uses member role-change and member-leave events to keep those configured rosters current. It does not use this intent to read messages, track presence, or build a general-purpose profile of members. Roster and tenure data is stored in the bot operator's local `data/guild-settings.json` file and is used only for the configured server's management roster and announcements. The JSON data files are encrypted at rest with AES-256-GCM using a deployment-specific key stored in the operator's `.env` file. Server administrators control which roles and channels are configured. The operator can delete local data files to remove stored records; historical records are not automatically purged on a fixed schedule.

### 中文对照

> 本机器人将 Server Members（Guild Members）意图用于由服务器管理员主动启用的管理组名单功能。管理员通过机器人内面板指定一个或多个管理身份组。名单初始化或刷新时，机器人读取服务器成员列表，仅筛选持有已配置身份组的真人成员，并排除机器人账号。机器人记录成员 ID 以及任职/卸任时间，用于发布当前名单和任免公示；同时通过成员身份组变更和成员离开事件维护名单。机器人不会借此读取消息、追踪在线状态或建立通用成员画像。任期名单数据保存在机器人运营者本地的 `data/guild-settings.json`，仅用于已配置服务器的管理组名单和公示。服务器管理员控制配置哪些身份组和频道。运营者可删除本地数据文件以移除保存的名单和配置数据。

## Message Content Intent: recommendation and explanation

**Do not request this intent for the current code.** The bot receives commands through Discord interactions and does not subscribe to `GatewayIntentBits.MessageContent` or process `messageCreate` events. `/提问` sends only the text explicitly submitted as that command, plus a bounded in-memory conversation history, to the API endpoint configured by the operator. That is interaction input and an explicit API feature, not bulk access to ordinary channel messages through the Message Content Intent.

If the Developer Portal currently has Message Content enabled, turn it off for least privilege unless the code is changed to add a genuine feature that cannot reasonably use interactions, and that feature is disclosed to users. Do not tell Discord reviewers that this bot scans or moderates all messages; it currently does not.

## Evidence checklist for screenshots or a short demo

Capture a short, unedited demonstration in a private test server using test accounts and redacted IDs:

1. Show the bot's management panel with an administrator-selected management role and roster channel.
2. Show the bot listing only human members with that role and omitting bot accounts.
3. Show a test member receiving/removing that role and the bot updating its roster/announcement.
4. Show that the bot's command list is interaction-based and that ordinary messages do not trigger the bot.
5. In Developer Portal, show Server Members enabled and Message Content/Presence disabled. Hide the application ID if desired; never show a Bot Token, API key, `.env`, or real users' private information.

Do not stage a demo with real disciplinary records, private channel contents, real reasons, or identifiable members unless they have agreed to appear in review evidence.

## Submission steps

1. Confirm the app's current user count and read the exact notice in Developer Portal. Discord's current guidance says the review threshold is 10,000 unique users who can access the app across its servers, replacing the former server-count threshold. Apps already granted access must reapply annually when notified.
2. If below the threshold, enable only the needed Server Members Intent under **Developer Portal → Application → Bot → Privileged Gateway Intents**. A review may not be required yet. If the portal says review is required, submit the English explanation above and evidence through the portal's review flow.
3. Keep the code and portal settings aligned: this source requests `GuildMembers`; do not add Message Content or Presence without a real feature need.
4. After changing portal or code settings, restart the bot and test roster initialization, role updates, member departures, and bot-account exclusion in a test server.
5. If Discord asks for a privacy policy or public project details, publish `PRIVACY.md` at a stable public URL and replace its operator contact placeholder before submission.

## Official references

- [Discord: Getting Started with Privileged Intent Review](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review)
- [Discord: Updated Requirements to How Apps Access Data in Servers](https://discord.com/blog/updated-requirements-to-how-apps-access-data-in-servers)
- [Discord: What are Privileged Intents?](https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents)
