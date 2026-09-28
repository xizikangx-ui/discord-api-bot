# Discord Privileged Intent Review Notes

This document describes the current code in this repository. Keep it accurate if the bot's features change.

## Current intent audit

| Intent | Enabled in code | Needed | Reason |
|---|---:|---:|---|
| Guild Members / Server Members Intent | Yes (`GatewayIntentBits.GuildMembers`) | Yes, for configured roster features | Fetch the members holding administrator-selected management roles, and track role/member changes to maintain the roster and appointment history. |
| Guild Message Reactions | Yes (`GatewayIntentBits.GuildMessageReactions`) | Yes, for the opt-in reaction cleanup feature | Compare the message author ID and added emoji with administrator-configured rules, then remove only the matching emoji reaction from that message. The message and other emoji reactions remain untouched. |
| Message Content Intent | No | No | The bot does not read message text. It uses interactions and reaction events; the reaction cleanup checks only author/emoji metadata and does not scan ordinary message content. |
| Guild Presences / Presence Intent | No | No | No online status, activity, or presence feature exists. |

The project enables `Guilds`, `GuildMembers`, and the non-privileged `GuildMessageReactions` intent. Do not claim a need for Message Content or Presence access based on this code.

## Paste-ready application text: Server Members Intent

### English

> This bot uses the Server Members (Guild Members) intent for its opt-in management roster feature. A server administrator configures the specific management role or roles through the bot's in-server panel. When the roster is initialized or refreshed, the bot fetches guild members, filters them to members holding only those configured roles, and excludes bot accounts. It records the member ID and appointment start/end timestamps so it can publish the current roster and appointment/resignation notices. The bot also uses member role-change and member-leave events to keep those configured rosters current. It does not use this intent to read messages, track presence, or build a general-purpose profile of members. Roster and tenure data is included in operational state encrypted with AES-256-GCM before upload to the operator's private Discord storage channel. The encryption key is kept on the Bot host and is not uploaded to Discord or included in the public repository; the Bot decrypts the state in memory. The channel is restricted to the Bot and trusted administrators. During migration, old channel messages and local files are not automatically deleted; the operator verifies the encrypted copy and removes unneeded legacy copies. Users can request access, correction, or deletion through the published contact address. Historical records do not have a fixed automatic purge schedule.

### 中文对照

> 本机器人将 Server Members（Guild Members）意图用于由服务器管理员主动启用的管理组名单功能。管理员通过机器人内面板指定一个或多个管理身份组。名单初始化或刷新时，机器人读取服务器成员列表，仅筛选持有已配置身份组的真人成员，并排除机器人账号。机器人记录成员 ID 以及任职/卸任时间，用于发布当前名单和任免公示；同时通过成员身份组变更和成员离开事件维护名单。机器人不会借此读取消息、追踪在线状态或建立通用成员画像。任期名单数据包含在状态附件中，上传到运营者指定的 Discord 私密存储频道前使用 AES-256-GCM 加密；密钥仅保存在 Bot 主机，不上传到 Discord 或公开仓库。Bot 运行时在内存中解密。迁移期间旧频道消息和本地旧文件不会自动删除；运营者确认加密副本有效后清理不再需要的旧副本。用户可联系运营者请求访问、更正或删除数据；历史记录没有固定自动清理期限。

## Message Content Intent: recommendation and explanation

**Do not request this intent for the current code.** The bot receives commands through Discord interactions and does not subscribe to `GatewayIntentBits.MessageContent`. Its reaction cleanup feature listens for reaction events, compares only the configured message author IDs and emoji IDs/names, and removes only a matching emoji reaction. It does not read or scan message text. The `/提问` command and external AI API integration have been removed.

If the Developer Portal currently has Message Content enabled, turn it off for least privilege unless the code is changed to add a genuine feature that cannot reasonably use interactions, and that feature is disclosed to users. Do not tell Discord reviewers that this bot scans or moderates all messages; it currently does not.

## Evidence checklist for screenshots or a short demo

Capture a short, unedited demonstration in a private test server using test accounts and redacted IDs:

1. Show the bot's management panel with an administrator-selected management role and roster channel.
2. Show the bot listing only human members with that role and omitting bot accounts.
3. Show a test member receiving/removing that role and the bot updating its roster/announcement.
4. Show the interaction-based command list. For reaction cleanup, demonstrate that a configured emoji is removed while the message and a different emoji remain; do not expose message text or private member information.
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
