# 隐私政策 / Privacy Policy

**生效日期：2026-09-28**  
**运营者联系邮箱：`xizikangx@gmail.com`**

本政策适用于使用本仓库代码自行部署的 Discord Bot。每个部署实例由部署者独立运营；部署者应在公开本政策前填写有效联系方式，并根据实际托管方式和服务器配置更新本政策。

## Bot 会处理哪些信息

### Discord 账号、服务器和身份组数据

启用管理组/中层管理名单功能后，Bot 会使用 Server Members Intent 读取服务器成员和身份组，以筛选管理员配置的管理身份组成员，并处理身份组变更或成员离开事件。启用表情反应清理后，Bot 会接收服务器的消息反应事件，并对照管理员设置的作者 ID 和表情 ID/名称；匹配时移除该消息上的该种表情反应。Bot 不保存消息正文或发言历史。运行数据可能包含服务器、频道、身份组、消息、用户和管理员的 Discord ID，任职/卸任时间、处罚编号、处罚原因、提醒内容和执行状态。启用版务审批时，还会保存申请目标链接及其频道/消息 ID、申请人 ID、投票人 ID、投票选择、票数、审批状态和时间。Bot 账号会从管理组名单中排除。

这些数据用于处罚、撤销、管理组名单、公示、提醒、续禁、表情反应清理和经审批的帖子管理/内容删除等已配置功能。Bot 不读取在线状态，也不会扫描或归档普通聊天内容；反应清理只检查网关反应事件中的作者/表情信息，不分析消息正文；内容删除申请只读取申请链接指定的目标消息以确认对象，达到审批门槛后才删除。

### Bot 发言与 Discord 交互

`/说话` 的文本由 Bot 发送到用户调用命令的频道或子区；Discord 可能会显示谁使用了斜杠命令。`/说话转发` 由有权查看源频道的操作者提交本服务器内某条具体消息的链接；Bot 按该链接获取消息，并请求 Discord 将它原生转发到当前频道或子区。Bot 不会为此扫描其他消息，也不会把源消息正文写入 Bot 的持久状态；转发后的消息保留在目标 Discord 频道，受该频道权限和保留设置约束。对于 Bot 无法读取内容的消息，Discord 可能拒绝转发（错误 160014）；如获批并启用 Message Content Intent，该权限仅用于按操作者指定的链接读取待转发消息，不用于表情反应清理。消息作者目前没有应用内自助退出单次转发的开关，可联系运营者处理相关请求。Bot 会接收其斜杠命令、按钮、菜单和表单交互所需的数据。当前代码尚未启用 Message Content Intent，也没有普通消息事件监听器，因此不会批量读取或储存普通频道消息。

## 保存位置与保留时间

管理组任期、处罚、提醒、服务器配置、长禁言续期任务和待确认处罚保存在部署者配置的 Discord 私密频道附件中。上传前使用部署者提供的 `DATA_ENCRYPTION_KEY` 通过 AES-256-GCM 加密；密钥只保存在运行 Bot 的主机 `.env` 文件或密钥管理服务中，不会发到 Discord 或提交到代码仓库。Bot 运行时会在内存中解密和处理记录。Discord 频道访问权限由部署者设置；应仅允许 Bot 和确有需要的可信管理员访问，并妥善管理服务器邀请权限。首次启动时，如果新 Discord 私密频道还没有状态记录，Bot 可从配置的旧 Discord 频道迁移，或从已有的本地 `data/` 文件导入，再将状态加密后写入新频道。成功保存到 Discord 后，Bot 会自动将已知的本机旧状态文件（服务器设置、长禁言任务和待确认处罚文件）原位改写为 AES-256-GCM 加密格式；这些加密副本仍会留在 Bot 主机，直到部署者手动删除。旧 Discord 频道消息、独立备份、终端记录和其他未识别的副本不会自动删除或加密，部署者应检查并妥善保护或清理。丢失加密密钥将导致状态无法解密。

当前代码没有统一的自动清理期限来删除历史处罚案、管理组任期、公示配置或提醒记录；已完成的历史记录可能继续以密文保存在 Discord 存储频道和本机状态副本中，直到部署者删除。数据仅应在仍为已启用功能所必需时保留；用户可通过下方邮箱提出访问、更正或删除请求，部署者应及时处理。停止运行 Bot 时，部署者应删除不再需要的 Bot 状态附件及本地迁移旧文件。部署者使用的终端、进程管理器或云主机可能另行保存日志，其保留规则由部署者决定。

## 信息共享

- Discord API 会处理 Bot 正常运行所需的命令、成员资料和消息发送/管理请求。
- Bot 不会把运行数据发送给本仓库维护者或外部 AI/API 服务；本项目没有内置遥测或分析上报功能。
- 部署者可能选择将处罚与撤销记录发送到配置的 Discord 频道。服务器成员能否看到这些频道由该服务器的权限设置决定。

## 用户请求、纠正与删除

如需咨询、纠正或删除某次部署持有的数据，请联系该 Bot 的运营者：`xizikangx@gmail.com`，并提供你的 Discord 用户 ID、相关服务器和请求内容。部署者会核实请求并在 Discord 存储记录及部署者控制的备份中查找、更新或删除对应数据；如果请求涉及仍在运行的功能，部署者会说明影响。也可联系相关服务器管理员。

## 未成年人及政策更新

Bot 不以年龄为条件建立用户画像。服务器管理员和部署者应遵守适用法律、Discord 开发者条款及服务器规则。功能或数据处理方式发生变化时，部署者应更新此政策并告知受影响用户。

## English summary

This self-hosted bot processes Discord IDs, configured role membership, appointment history, moderation cases, reminder settings, configured reaction-cleanup rules and (when enabled) content moderation proposal links and approval votes to provide the features administrators enable. It uses the Server Members Intent for configured management rosters and the non-privileged Guild Message Reactions intent to compare reaction events with configured message authors and emojis. The `/说话转发` command fetches only a specific same-server message selected by an operator who can view its source channel, then asks Discord to forward it to the current channel or thread. Source message content is not added to the bot's persistent state; the forwarded message remains on Discord under the destination channel's access and retention settings. Some messages cannot be forwarded without Message Content access (Discord error 160014). If that intent is approved and enabled, it will be used for these operator-selected forwards, not for reaction cleanup or bulk message scanning. Authors currently have no in-app self-service opt-out for an individual forward and may contact the operator about a request. The current code does not enable Message Content or Presence intents and does not analyze ordinary message text for reaction cleanup. A message may be fetched to complete a partial reaction event, but its content is not read or stored. The `/提问` command and external AI API integration have been removed. Persistent operational state is encrypted with AES-256-GCM before it is uploaded as a bot-authored attachment to the private Discord channel selected by the operator. The encryption key is kept in the operator's local `.env` file or a secrets manager and is not stored in Discord or the public repository. The Bot decrypts state in memory while running. After successful Discord storage, the bot also encrypts its known local legacy state files in place; the encrypted copies remain on the host until the operator deletes them. Legacy Discord-channel messages, separate backups and logs are not automatically removed or encrypted and must be reviewed and protected by the operator. Historical cases, proposals and tenure records have no fixed automatic deletion schedule; records should be removed when no longer needed, and users can request access, correction or deletion by contacting the operator at `xizikangx@gmail.com`. When enabled, punishment cases may be synchronized between the two servers configured by the operator, with records written to each server's configured channels. The operator must verify this policy against the actual deployment and data-sharing settings.
