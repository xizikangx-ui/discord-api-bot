# Discord API Bot 部署指南

这是一个接入 OpenAI Chat Completions 兼容 API 的 Discord Bot。所有斜杠指令、子指令和参数都使用中文。

公开版本不包含 `.env`、`node_modules/` 或 `data/` 运行数据。隐私政策见 [PRIVACY.md](PRIVACY.md)，特权意图审核准备资料见 [PRIVILEGED_INTENT_REVIEW.md](PRIVILEGED_INTENT_REVIEW.md)。

## 管理指令

- `/提问 问题:...`：向已接入的 API 提问。
- `/说话 内容:... 回复消息链接:...`：机器人以自己的 Bot 账号直接在当前频道或子区发言；可选填写同一频道/子区的消息链接，让机器人以 Discord 回复形式回复该消息。论坛请先打开具体帖子，再在帖子内调用。只允许拥有“管理消息”权限的成员使用。Discord 可能会显示谁调用了斜杠指令；机器人无法隐藏 Discord 自己显示的调用提示。
- `/编辑说话 消息链接:... 新内容:...`：粘贴 Discord 消息链接来修改机器人之前发送的消息。只能编辑本机器人在当前服务器发出的消息；使用者需要“管理消息”权限，并在仅管理人员可见的私密频道中调用。
- `/配置身份组 添加 成员:@成员 身份组:@身份组`：给成员添加身份组。
- `/配置身份组 移除 成员:@成员 身份组:@身份组`：移除成员身份组。
- `/定时提醒 添加`：选择频道、几分钟后、重复间隔、文字，以及可选的成员或身份组提及。重复间隔填 `0` 表示只提醒一次；重复提醒最短 10 分钟。用 `/定时提醒 列表` 查看编号，用 `/定时提醒 删除` 取消。
- `/处罚面板`：发送 Discord 内配置面板，可选择主要处罚记录频道、可选留痕频道和警告身份组，并开启/关闭警告后的二次私信提醒（24 小时后）。新处罚与撤销记录会同时写入主要记录频道和留痕频道；未配置留痕频道时只写主要记录频道。可在面板清除留痕频道。
- `/处罚`：同一个指令里选择「仅警告」「仅禁言」或「警告并禁言」，填写成员和原因；对应填写禁言天数、警告天数。机器人会先弹出确认卡，只有发起者本人点击“确认执行”才会处罚；确认记录保存在项目 `data/pending-punishments` 目录，15 分钟失效。若 Bot 实例从不同目录收到按钮，仍可从确认卡恢复请求；卡片显示警告期、处罚案计算的剩余期限及 Discord 当前禁言剩余时间。操作者不需要 Discord 的“管理身份组”或“管理成员”权限，Bot 本身需要相应权限。警告天数留空时，警告身份组不自动移除。禁言支持 1 到 90 天，超过 28 天会自动续期。对同一成员的新处罚会覆盖上一笔仍生效的处罚效果，旧案保留在历史记录并标记为已覆盖。
- `/撤销处罚 处罚编号:...`：按处罚记录中的编号撤销该笔仍生效的处罚；警告、禁言或两者会按原处罚内容撤销，并在处罚频道新增撤销记录。已被新处罚覆盖或已撤销的旧编号不能再次撤销。根据原处罚内容，需要“管理身份组”和/或“管理成员”权限。
- `/管理组面板`：选择管理组身份组和实时名单频道，并多选成员任命或代为卸任。可点击“创建任免公示子区”将任命、卸任记录单独发布到子区；实时名单仍留在原频道。
- `/管理组名单`：查看当前在任成员和各自任命时间。
- `/管理组卸任 理由:...`：当前管理组成员可自行卸任并填写可选理由；超级管理员或有“管理身份组”权限的管理员也可在面板里替他人卸任并填写理由。
- `/中层管理面板`：先选择一个中层身份组和公示频道，Bot 会创建实时名单子区与独立的任免公示子区；已存在的配置也可点击“创建任免公示子区”。任免公示位置与实时名单位置分开，不会移动实时名单。
- `/中层管理名单 身份组:@身份组`：查看该中层身份组的在任成员与任职时间。
- `/中层管理卸任 身份组:@身份组 理由:...`：当前成员可选择自己持有的中层身份组自行卸任，并将理由写入该组对应的任免公示子区。

管理组面板配置好身份组和公示频道后，会读取该身份组现有真人成员；首次读取时以当前时间作为这些成员的任期起点。此后机器人会监听身份组变更并自动维护任命、卸任记录和公示名单；成员离开服务器或身份组被移除，也会结束任期。自动读取和自动检测产生的公示不显示理由；手动任命或卸任仍可填写理由。Bot 账号会从任期和公示名单中排除，不会自动移除它们已有的身份组。实时名单留在已配置频道；任免记录会发到单独的任免公示子区。

中层管理使用独立的身份组、实时名单子区、任免公示子区和任期记录；同样会从首次配置时开始登记，并自动跟踪身份组变更。人数较多时，当前名单会自动拆成多条公示消息以符合 Discord 的消息长度限制。管理组与中层管理可分别维护，不会覆盖彼此的设置。

权限由 Discord 命令权限和 Bot 代码双重检查：`/配置身份组` 需要操作者有“管理身份组”权限；`/处罚` 不检查操作者的管理权限，Bot 本身须有分配警告身份组或执行禁言所需的权限，目标身份组层级也必须低于 Bot。处罚前会要求发起者二次确认。`/撤销处罚` 按处罚内容检查操作者权限。`/说话` 需要“管理消息”权限以及 Bot 在当前频道或子区的发送权限。处罚记录卡会显示成员、管理员、原因、警告/禁言时长和处罚 ID。Discord 自身可能显示斜杠指令调用提示。

超过 28 天的续禁计划保存在 `data/long-timeouts.json`。请保留此文件和项目目录，并尽量让 Bot 持续在线。电脑关机或 Bot 离线时无法准时续禁；重启后会尝试恢复尚未结束的续禁计划。对话上下文仍只在内存中，重启后清空。

处罚、提醒和管理组任期配置保存在 `data/guild-settings.json`，请备份此文件。Bot 需要在处罚记录频道、提醒目标频道和管理组公示频道有查看/发送消息权限。提及只会通知你选定的成员或身份组；若身份组没有开启“允许任何人提及”，则需给 Bot“提及 @everyone、@here 和所有身份组”权限。警告二次提醒会在 24 小时后私信成员；若对方关闭了服务器私信，Discord 可能拒绝投递，但处罚记录仍保留。警告身份组到期自动移除、定时提醒和管理组名单更新都要求 Bot 在线。`/处罚面板`、`/管理组面板` 需要“管理服务器”权限；执行警告或任命/卸任需要“管理身份组”，执行禁言需要“管理成员”。Bot 的身份组必须高于所管理的身份组及成员。管理组功能还要求在 Developer Portal 开启 Server Members Intent。

## 1. 创建 Discord Bot

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)，新建 Application。
2. 在 **Bot** 页面创建 Bot，并复制 Token。Token 只放在自己的 `.env` 文件，切勿发给别人或提交到代码仓库。
3. 在 **General Information** 页面复制 **Application ID**，稍后作为 `DISCORD_CLIENT_ID`。
4. 进入 **OAuth2 → URL Generator**，勾选 `bot` 和 `applications.commands`。在 Bot Permissions 勾选 `View Channels`、`Send Messages`、`Create Public Threads`、`Send Messages in Threads`、`Manage Threads`、`Read Message History`、`Manage Messages`、`Manage Roles`、`Moderate Members`。打开生成的 URL，把 Bot 邀请到你的服务器。如果 Bot 已经加入服务器，再用此链接授权一次以更新权限，或在服务器设置中给 Bot 身份组添加这些权限。
5. 复制服务器 ID：Discord 设置中启用 **Advanced → Developer Mode**，在服务器图标上右键复制 ID。需要指定多个服务器时，用逗号分隔填写 `DISCORD_GUILD_IDS`；留空则注册为全局指令。
6. 为管理组名单读取和成员身份组变更跟踪，在 **Bot → Privileged Gateway Intents** 开启 **Server Members Intent** 并保存。此项目不读取普通聊天内容，代码未启用 Message Content Intent；除非未来确实增加必须扫描普通消息的功能，否则请在 Developer Portal 关闭该项。之后重启机器人。

## 2. 配置 API 和启动

需要 Node.js 24.5 或更高版本。将此文件夹放在你自己的电脑或服务器上，在文件夹内运行：

```powershell
Copy-Item .env.example .env
notepad .env
npm install
npm start
```

编辑 `.env`，填入：

- `DISCORD_TOKEN`：Bot Token
- `DISCORD_CLIENT_ID`：Application ID
- `DISCORD_GUILD_IDS`：可选的服务器 ID 列表，用逗号分隔；留空时注册全局命令。兼容旧配置 `DISCORD_GUILD_ID`。
- `API_BASE_URL`：API 根地址，例如 `https://api.openai.com/v1`
- `API_KEY`：API 密钥
- `API_MODEL`：服务商支持的模型 ID
- `DATA_ENCRYPTION_KEY`：本部署专用的 32 字节 Base64 密钥，用于 AES-256-GCM 加密 `data/` 中的 JSON 文件。生成方式：

  ```powershell
  node -p "require('node:crypto').randomBytes(32).toString('base64')"
  ```

  将输出填入 `.env` 的 `DATA_ENCRYPTION_KEY`。不要公开或丢失该密钥；迁移数据或恢复备份时必须使用同一个密钥。首次启动新版会将现有明文 JSON 文件加密后再连接 Discord。

启动成功后，在服务器输入 `/提问` 并填写“问题”。管理指令也会在 Bot 启动时注册。切勿把密钥写进 `src/bot.js` 或发到 Discord。

### 兼容性

默认请求 `POST {API_BASE_URL}/chat/completions`，发送 Bearer API Key 和 `{ model, messages }`，并读取 `choices[0].message.content`。如果服务商的路径不同，可设置 `API_PATH`，例如 `/v1/chat/completions`；相应调整 `API_BASE_URL`，避免重复 `/v1`。若服务商使用不同的请求或响应格式，需要改 `src/bot.js` 中的 `askApi` 函数。

## 3. 让 Bot 持续在线

### Linux VPS（推荐用 PM2）

安装 Node.js 24.5+，把项目上传到 VPS；在项目目录配置 `.env`，然后运行 `npm start`。如果 VPS 不需要代理，可以从 `.env` 删除 `HTTP_PROXY` 和 `HTTPS_PROXY` 两行；如需代理，请填写 VPS 上可用的代理地址。`npm start` 会加载 `.env` 并启用 Node.js 代理支持。

```bash
npm install
sudo npm install -g pm2
pm2 start npm --name discord-api-bot -- start
pm2 save
pm2 startup
```

`pm2 startup` 会打印一条需要执行的系统命令，按提示运行。查看日志：`pm2 logs discord-api-bot`。更新代码后：`pm2 restart discord-api-bot`。

### Windows 自己的电脑

在 PowerShell 项目目录运行 `npm start`，窗口保持运行即可。要持续在线，电脑必须开机且网络可用；更可靠的方式是部署到 VPS 或支持常驻进程的主机。不要把 `.env` 上传到公开仓库。

## 常见问题

- **看不到中文指令**：重启 Bot 等它重新注册指令；确认邀请链接包含 `applications.commands`，并且 `DISCORD_GUILD_IDS` 中有该服务器 ID。Discord 客户端可能需要稍等或重新打开。每条指令会先独立确认交互，再执行可能较慢的 API 操作；同时运行的指令不共享等待队列。
- **管理指令报权限错误**：确认 Bot 的身份组有对应权限，并拖到需要管理的身份组/成员上方；操作者本人也必须有对应权限。
- **90 天禁言无法持续**：保持 Bot 和主机持续在线；不要删除项目里的 `data/long-timeouts.json`。Bot 离线时不能执行自动续禁。
- **Missing required environment variables**：检查 `.env` 是否位于项目根目录、变量名是否拼对，且没有把值写在引号外的注释后面。
- **API 返回 401/403/404**：检查 API Key、模型名、`API_BASE_URL` 和 `API_PATH`。不同服务商的模型名和兼容范围各异。
- **Bot 离线**：确认 `npm start` 的进程仍在运行并检查控制台日志。
- **管理组面板报 Unknown Message（10008）**：公示名单消息可能被删。新版会自动重新创建；请将最新 `src/bot.js` 部署到服务器并重启 Bot。
