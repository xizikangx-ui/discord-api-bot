# 隐私政策 / Privacy Policy

**生效日期：2026-09-28**  
**运营者联系邮箱：`xizikangx@gmail.com`**

本政策适用于使用本仓库代码自行部署的 Discord Bot。每个部署实例由部署者独立运营；部署者应在公开本政策前填写有效联系方式，并根据实际 API 服务商、托管方式和服务器配置更新本政策。

## Bot 会处理哪些信息

### Discord 账号、服务器和身份组数据

启用管理组/中层管理名单功能后，Bot 会使用 Server Members Intent 读取服务器成员和身份组，以筛选管理员配置的管理身份组成员，并处理身份组变更或成员离开事件。运行数据可能包含服务器、频道、身份组、消息、用户和管理员的 Discord ID，任职/卸任时间、处罚编号、处罚原因、提醒内容和执行状态。Bot 账号会从管理组名单中排除。

这些数据用于处罚、撤销、管理组名单、公示、提醒和续禁等已配置功能。Bot 不读取在线状态，也不会通过普通消息扫描聊天内容。

### 用户主动提交的 `/提问` 内容

当用户调用 `/提问` 时，Bot 会把用户主动提交的问题、系统提示词以及该用户在同一服务器/频道中暂存的有限对话历史发送到部署者在 `.env` 配置的 Chat Completions 兼容 API 服务。历史默认最多保留 12 条消息，并只存在运行内存中；Bot 重启后清空。该请求可能包含用户自行输入的个人信息，请勿提交不必要的敏感信息。API 服务商如何处理请求数据，取决于部署者选择的服务商及其政策。

### Bot 发言与 Discord 交互

`/说话` 的文本由 Bot 发送到用户调用命令的频道或子区；Discord 可能会显示谁使用了斜杠命令。Bot 会接收其斜杠命令、按钮、菜单和表单交互所需的数据。当前代码没有启用 Message Content Intent，也没有普通消息事件监听器，因此不会批量读取或储存普通频道消息。

## 保存位置与保留时间

管理组任期、处罚、提醒和服务器配置保存在部署机器项目目录下的 `data/guild-settings.json`；长时间禁言续期任务保存在 `data/long-timeouts.json`。待确认处罚会暂存于 `data/pending-punishments/`。这些文件不应提交到 GitHub。它们由部署者控制的设备或服务器持有，访问权限取决于该机器的文件系统和备份设置。

当前代码没有统一的自动清理期限来删除历史处罚案、管理组任期、公示配置或提醒记录。它们会在部署者手动清理运行数据、卸载并删除数据文件，或代码按功能处理过期任务时移除。部署者应限制文件访问权限、妥善保护备份，并在不再需要时删除数据。运行日志可能由部署者使用的终端、进程管理器或云服务另行保存；其保留规则由部署者决定。

## 信息共享

- Discord API 会处理 Bot 正常运行所需的命令、成员资料和消息发送/管理请求。
- 部署者配置的 AI/API 服务商会收到 `/提问` 的问题文本、系统提示和有限对话上下文。
- Bot 不会把运行数据发送给本仓库维护者；本项目没有内置遥测或分析上报功能。
- 部署者可能选择将处罚与撤销记录发送到配置的 Discord 频道。服务器成员能否看到这些频道由该服务器的权限设置决定。

## 用户请求、纠正与删除

如需咨询、纠正或删除某次部署持有的数据，请联系该 Bot 的运营者：`xizikangx@gmail.com`。服务器管理员也可联系部署者，要求其更正设置或删除相应本地数据文件。由于本项目当前没有面向用户的导出/删除命令，运营者需要根据请求手动查找并处理本地记录；删除整个数据文件可能同时清除该服务器其他功能的配置和记录。

## 未成年人及政策更新

Bot 不以年龄为条件建立用户画像。服务器管理员和部署者应遵守适用法律、Discord 开发者条款及服务器规则。功能或数据处理方式发生变化时，部署者应更新此政策并告知受影响用户。

## English summary

This self-hosted bot processes Discord IDs, configured role membership, appointment history, moderation cases and reminder settings to provide the features administrators enable. It uses the Server Members Intent for configured management rosters. It does not enable Message Content or Presence intents and does not scan ordinary channel messages. Text explicitly submitted through `/提问`, together with a bounded in-memory conversation history, is sent to the API endpoint selected by the operator. Persistent operational data is stored in local `data/` files controlled by the operator; the current code does not automatically purge historical cases or tenure records. Contact the operator at the address above for privacy or deletion requests. The operator must verify this policy against their actual deployment before publication.
