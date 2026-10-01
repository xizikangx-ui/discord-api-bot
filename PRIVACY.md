# 隐私政策 / Privacy Policy

**生效日期：2026-10-01**
**运营者联系邮箱：`xizikangx@gmail.com`**

本政策适用于使用本仓库代码自行部署的 Discord Bot。每个部署实例由部署者独立运营；部署者应在公开本政策前填写有效联系方式，并根据实际托管方式和服务器配置更新本政策。

## Bot 会处理哪些信息

### Discord 账号、服务器和身份组数据

启用管理组/中层管理名单功能后，Bot 会使用 Server Members Intent 读取服务器成员和身份组，以筛选管理员配置的管理身份组成员，并处理身份组变更或成员离开事件。非主管理组成员使用普通 `/说话` 提及身份组时，Bot 还会逐页读取服务器成员及其身份组，在内存中计数，以阻止提及超过 100 人的身份组；计数结果不另行持久保存。启用表情反应清理后，Bot 会接收服务器的消息反应事件，并对照管理员设置的作者 ID 和表情 ID/名称；匹配时移除该消息上的该种表情反应。运行数据可能包含服务器、频道、身份组、消息、用户和管理员的 Discord ID，任职/卸任时间、处罚编号、处罚原因、提醒内容和执行状态。启用版务审批时，还会保存申请目标链接及其频道/消息 ID、申请人 ID、投票人 ID、投票选择、票数、审批状态和时间。Bot 账号会从管理组名单中排除。

这些数据用于处罚、撤销、管理组名单、公示、提醒、续禁、表情反应清理和经审批的帖子管理/内容删除等已配置功能。Bot 不读取在线状态；反应清理只检查网关反应事件中的作者/表情信息，不分析消息正文；内容删除申请只读取申请链接指定的目标消息以确认对象，达到审批门槛后才删除。紧急频道功能的聊天记录处理见下文。

### Bot 发言与 Discord 交互

启用违规改名面板后，Bot 保存允许操作的身份组、目标必需违规身份组、启停状态和当前昵称锁定记录（目标/操作者 ID、改名理由、违规身份组、时间）。这些设置与记录随服务器状态加密保存。获授权的操作员提交改名后，Bot 将目标服务器昵称改为其数字用户 ID，通过成员更新事件及定期检查保持该昵称；移除指定违规身份组、离服或手动解除锁定后删除该成员的锁定记录并停止自动改回。更换面板中的违规身份组会解除全部已有锁定。暂停功能会保留记录。Bot 不改变账号名或用户数字 ID，不为此保存聊天内容。

启用中层申请面板后，Bot 会保存每套面板的名称、说明、前置/发放身份组、审批/公开频道、审批票数和已发布消息 ID；还会保存申请人 ID、申请理由、提交时间、申请时的身份组要求、审批人 ID、票数、处理结果和失败说明。这些记录随服务器状态用 AES-256-GCM 加密保存到部署者的 Discord 私密存储频道，没有自动删除期限。理由和审批信息会显示在管理员配置的审批频道，申请人可查看自己的申请状态；部署者应限制审批频道访问。公开申请面板仅显示要求、目标身份组真人数和待审批人数，不显示申请理由。Bot 通过 Server Members Intent 读取成员身份组，在内存中维护人数，并监听身份组变更和进退服；用于人数统计的完整成员列表不另行持久保存。审批通过后 Bot 发放配置的身份组，申请人不能审批自己的申请。

`/说话` 的文本由 Bot 发送到用户调用命令的频道或子区；Discord 可能会显示谁使用了斜杠命令。`/管理说话` 会先核对主管理组身份组或服务器管理员权限，再发送含发言人 ID 的可核验卡片。卡片认证码由 Bot 的私密密钥签署正文、频道和发言人；密钥不会发到 Discord，核验由 Bot 在内存中完成。正文和发言人信息会显示在目标频道中。`/说话转发` 由有权查看源频道的操作者提交本服务器内某条具体消息的链接；Bot 按该链接获取消息，并请求 Discord 将它原生转发到当前频道或子区。Bot 不会为此扫描其他消息，也不会把源消息正文写入 Bot 的持久状态；转发后的消息保留在目标 Discord 频道，受该频道权限和保留设置约束。对于 Bot 无法读取内容的消息，Discord 可能拒绝转发（错误 160014）。消息作者目前没有应用内自助退出单次转发的开关，可联系运营者处理相关请求。Bot 会接收其斜杠命令、按钮、菜单和表单交互所需的数据。Bot 不监听普通消息事件，反应清理不需要 Message Content Intent。

使用 `/说话` 或 `/管理说话` 时，Bot 会先在同一信息存储服务器的独立私密留档频道记录操作者 ID、指令类型、原频道 ID 和发送状态；成功后补上 Bot 消息链接。发言正文、回复链接、图片名称和图片链接会使用 AES-256-GCM 加密为附件，图片原件不会另行复制到留档频道。留档服务器中持有“管理服务器”权限的人可通过记录卡获取仅自己可见的解密文件。留档写入失败时，Bot 不会代发。该留档没有自动删除期限，由部署者管理频道访问和记录保留。

### 紧急频道聊天记录

主管理组成员可创建临时文字频道，并选择一个私密记录频道。开设时可以选择可进入的身份组，也可以不分配身份组；创建者和 Bot 默认可进入。管理组成员可以通过频道内按钮邀请指定成员，向他们开放查看、发言、创建公共子区、添加反应和查看历史消息权限。管理组成员点击“记录并关闭”且再次确认后，Bot 最多读取该临时频道及其子区合计 5000 条消息，包括作者 ID、时间、正文、嵌入内容及附件链接；不会下载附件原件。Bot 将文字记录用部署者提供的 `DATA_ENCRYPTION_KEY` 进行 AES-256-GCM 加密，作为附件发到所选 Discord 私密记录频道；管理员点击记录卡时，Bot 才会在内存中解密，并以仅该操作者可见的临时交互回复提供文件。创建人、关闭人、频道名称、理由和消息数量也会以未加密的文字出现在私密记录频道。记录上传成功、且确认频道没有新增消息后，Bot 删除原临时频道。若消息内容不可读取、记录不完整、过大或上传失败，Bot 保留原频道。启用此功能读取普通成员消息正文前，运营者应取得涵盖该用途的 Message Content Intent 批准；仅先前用于按链接转发消息的申请说明不能自动视为涵盖整段聊天记录导出。

## 保存位置与保留时间

管理组任期、处罚、提醒、服务器配置、长禁言续期任务和待确认处罚保存在部署者配置的 Discord 私密频道附件中。上传前使用部署者提供的 `DATA_ENCRYPTION_KEY` 通过 AES-256-GCM 加密；密钥只保存在运行 Bot 的主机 `.env` 文件或密钥管理服务中，不会发到 Discord 或提交到代码仓库。Bot 运行时会在内存中解密和处理记录。Discord 频道访问权限由部署者设置；应仅允许 Bot 和确有需要的可信管理员访问，并妥善管理服务器邀请权限。首次启动时，如果新 Discord 私密频道还没有状态记录，Bot 可从配置的旧 Discord 频道迁移，或从已有的本地 `data/` 文件导入，再将状态加密后写入新频道。成功保存到 Discord 后，Bot 会自动将已知的本机旧状态文件（服务器设置、长禁言任务和待确认处罚文件）原位改写为 AES-256-GCM 加密格式；这些加密副本仍会留在 Bot 主机，直到部署者手动删除。旧 Discord 频道消息、独立备份、终端记录和其他未识别的副本不会自动删除或加密，部署者应检查并妥善保护或清理。丢失加密密钥将导致状态无法解密。

当前代码没有统一的自动清理期限来删除历史处罚案、管理组任期、公示配置、提醒记录或紧急频道记录；加密记录可能继续保存在 Discord 私密频道和本机状态副本中，直到部署者删除。紧急频道的加密记录附件位于配置的 Discord 私密记录频道，删除原频道不会自动删除该附件。数据仅应在仍为已启用功能所必需时保留；用户可通过下方邮箱提出访问、更正或删除请求，部署者应及时处理。停止运行 Bot 时，部署者应删除不再需要的 Bot 状态附件及本地迁移旧文件。部署者使用的终端、进程管理器或云主机可能另行保存日志，其保留规则由部署者决定。

## 信息共享

- Discord API 会处理 Bot 正常运行所需的命令、成员资料和消息发送/管理请求。
- Bot 不会把运行数据发送给本仓库维护者或外部 AI/API 服务；本项目没有内置遥测或分析上报功能。
- 部署者可能选择将处罚与撤销记录发送到配置的 Discord 频道。服务器成员能否看到这些频道由该服务器的权限设置决定。

## 用户请求、纠正与删除

如需咨询、纠正或删除某次部署持有的数据，请联系该 Bot 的运营者：`xizikangx@gmail.com`，并提供你的 Discord 用户 ID、相关服务器和请求内容。部署者会核实请求并在 Discord 存储记录及部署者控制的备份中查找、更新或删除对应数据；如果请求涉及仍在运行的功能，部署者会说明影响。也可联系相关服务器管理员。

## 未成年人及政策更新

Bot 不以年龄为条件建立用户画像。服务器管理员和部署者应遵守适用法律、Discord 开发者条款及服务器规则。功能或数据处理方式发生变化时，部署者应更新此政策并告知受影响用户。

## English summary

The optional nickname panel stores authorized operator roles, the prerequisite violation role, an enabled flag and current locks containing target/operator IDs, reason, role and time. This state is encrypted with the other operational settings. An authorized operator can rename an eligible member's server nickname to their numeric user ID; the bot maintains that nickname through member updates and periodic checks. The lock is removed when the violation role is removed, the member leaves, or an operator releases it. Changing the configured violation role clears existing locks; pausing preserves them. The bot does not change account usernames or numeric user IDs, or store chat content for this purpose.

When middle-management application panels are enabled, the bot stores panel configuration, applicant IDs and reasons, submission timestamps, prerequisite and award roles, reviewer IDs, approval counts, results and failure details. These records are encrypted with AES-256-GCM as part of the private Discord operational state and have no automatic deletion period. The configured approval channel displays application reasons and review information; applicants can view their own status. Public panels display requirements, the number of human members holding the award role and pending application counts, without publishing reasons. The bot uses Server Members Intent to read role membership and update in-memory counts on role and membership changes; it does not separately persist the full member list used for counting. Roles are awarded after approval, and applicants cannot approve their own requests.

The `/管理说话` command checks the configured senior management role or server Administrator permission before posting a management announcement. The announcement publicly shows its speaker's Discord ID and message body. Its verification button checks a signature over the body, guild, channel and speaker using a secret that is not posted to Discord. Ordinary `/说话` users cannot create this signed announcement. For both `/说话` and `/管理说话`, the bot first writes an encrypted record to a separate private channel in the same storage server. The private channel shows the operator ID, command, source channel, delivery status and, after success, the bot message link. The message body, reply link, image names and image URLs are encrypted with AES-256-GCM in an attachment; image files themselves are not copied. Storage-server members with Manage Server permission may request a decrypted ephemeral copy. The bot does not send the original message if archive creation fails. These records have no automatic deletion period.

This self-hosted bot processes Discord IDs, configured role membership, appointment history, moderation cases, reminder settings, configured reaction-cleanup rules and (when enabled) content moderation proposal links and approval votes to provide the features administrators enable. It uses the Server Members Intent for configured management rosters and to count role members in memory when a user without the configured senior management role uses ordinary `/说话` to mention a role, rejecting roles with over 100 members without storing the count. It uses the non-privileged Guild Message Reactions intent to compare reaction events with configured message authors and emojis. The `/说话转发` command fetches only a specific same-server message selected by an operator who can view its source channel, then asks Discord to forward it to the current channel or thread. Source message content is not added to the bot's persistent state; the forwarded message remains on Discord under the destination channel's access and retention settings. Some messages cannot be forwarded without Message Content access (Discord error 160014). Authors currently have no in-app self-service opt-out for an individual forward and may contact the operator about a request. The bot does not enable Presence intent or analyze ordinary message text for reaction cleanup. A message may be fetched to complete a partial reaction event, but its content is not stored for that purpose. The `/提问` command and external AI API integration have been removed. Persistent operational state is encrypted with AES-256-GCM before it is uploaded as a bot-authored attachment to the private Discord channel selected by the operator. The encryption key is kept in the operator's local `.env` file or a secrets manager and is not stored in Discord or the public repository. The Bot decrypts state in memory while running. After successful Discord storage, the bot also encrypts its known local legacy state files in place; the encrypted copies remain on the host until the operator deletes them. Legacy Discord-channel messages, separate backups and logs are not automatically removed or encrypted and must be reviewed and protected by the operator. Historical cases, proposals and tenure records have no fixed automatic deletion schedule; records should be removed when no longer needed, and users can request access, correction or deletion by contacting the operator at `xizikangx@gmail.com`. Senior management members may create a private temporary emergency channel for selected roles or for no role; the creator and bot retain access. Managers may invite specific members with permission to view, send, create public threads, react and read message history. On explicit close confirmation, the bot reads up to 5,000 messages from that channel and its threads, including author IDs, timestamps, content, embeds and attachment URLs, encrypts the transcript with AES-256-GCM, and posts it to the configured private Discord record channel before deleting the temporary channel. Attachments themselves are not copied. Case metadata and the reason appear unencrypted in that private record channel. Managers can request a decrypted transcript through an ephemeral interaction. If message content is unavailable or the export fails, the channel remains. Enabling transcript export for ordinary member messages requires Message Content Intent approval covering this use; an earlier application describing only link-selected forwards should not be assumed to cover it. The encrypted record has no automatic deletion schedule. When enabled, punishment cases may be synchronized between the two servers configured by the operator, with records written to each server's configured channels. The operator must verify this policy against the actual deployment and data-sharing settings.
