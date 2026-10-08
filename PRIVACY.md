# 隐私政策 / Privacy Policy

**生效日期：2026-10-06**
**运营者联系邮箱：`xizikangx@gmail.com`**

本政策适用于使用本仓库代码自行部署的 Discord Bot。每个部署实例由部署者独立运营；部署者应在公开本政策前填写有效联系方式，并根据实际托管方式和服务器配置更新本政策。

## 跑团功能的数据与公开范围

势力功能保存角色所选势力、天启重工部门及修改时间，并在公开角色卡中显示归属；未建卡成员只读取背景文案。GM收购面板仅向配置GM展示指定玩家的背包、可出售数量和不可出售原因，保存临时报价步骤、数量、总价和确认结果。开箱保存1—6件物品的整批结果及各公示分段的发送状态，待领取批次不会在重启时重新生成；这些数据沿用下述加密存储、访问与审计规则。

仅在运营者指定的跑团服务器启用。Bot处理角色创建者ID、角色名称、属性与掷骰、等级、经验、生命、背包实例和冻结的模板版本、弹药和配件、游戏币、抽取次数和待领取掉落、装备槽位、交易报价及确认、NPC、战斗地图和阵营、行动预算、异常计时、攻防响应，以及GM和玩家的操作编号与时间。身份组领取配置、领取人ID、变更意图及结果也保存。配置和录入中的草稿绑定创建者和服务器，退出或重启后仍可继续。

角色属性和等级、战场HP/动作点/位置和异常摘要向该频道可见成员公开；背包、余额、抽取次数仅本人和配置的GM可以通过私密交互查看，交易详情仅参与方和GM可见。战场消息和申请/领取面板仍受Discord频道权限控制。跑团指令不扫描或保存普通聊天内容，不为参加、行动、投骰或自动推进收取现实费用。

食物、药品及其模板描述、恢复生命的骰点、解除异常、持续数值效果与行动次数/绝对到期时间随跑团状态保存。抽卡、开箱会在调用频道公开抽取者ID、物品名称、稀有度、描述、重量、游戏内估值、编号和待领取状态；不会一并公开余额、剩余次数或完整背包。公示消息编号、发送意图及发送结果保存在加密状态中，用于补发同一结果，避免重新抽取。

GM鉴定保存任务说明、判定规则、属性、门槛、次数上限、发布者/参与者ID、骰点、加成、成败、尝试时间及公示消息编号；任务和结果向对应频道成员公开。开团保存团名、说明、GM和报名成员ID、报名/退出记录、频道及卡片编号、绝对开团时间、提醒名单批次及发送状态。公共开团卡显示GM、时间、说明和人数，成员可查看报名名单；到时在原频道公开提及名单中的仍在服成员。发送前仅按报名ID核对是否在服，不扫描完整成员列表。取消停止后续提醒，历史名单、提醒及审计没有固定自动删除期限。

递进私有面板绑定操作者和步骤。用于编辑临时私有回复的交互句柄仅短时存于运行内存，不写入加密存档或日志；重启后需重新打开个人面板，持久草稿和战斗状态继续恢复。结束战斗移除操作按钮，公共结果、历史角色快照和操作审计仍保留。

每服务器跑团状态在内存中解密处理。生产环境通过Railway私网连接PostgreSQL，角色、战斗、地图及模板按对象压缩并以AES-256-GCM加密保存，使用现有秘密密钥；操作回执、审计和后台发送任务与资产变更一起提交。数据库中的服务器、对象和操作编号及版本作为检索元数据保存。Discord私密频道保存独立标记的加密备份，有变更时每5分钟更新，另保留6份每日、4份每周快照。迁移前存档保留。恢复从数据库读取，无法确认提交结果或失去独占运行锁时暂停修改，不能自动回退旧Discord备份。公共仓库、构建包和日志不包含角色资产正文、聊天正文或密钥；性能日志仅包含各阶段耗时、队列深度、事件循环延迟和Discord限流等待。NPC公开卡仅展示最新操作，内部完整事件、骰点和死亡奖励审计继续保留。

销卡会清空有效角色、资产、次数及槽位，取消未完成交易，恢复建卡额度；操作审计和历史战场角色快照保留。过期交易释放资产，但报价及结果不自动删除。草稿可由创建者删除；历史记录及审计没有固定自动到期时间，访问、更正、删除请求请联系运营者。配置GM角色会授予相关成员查看该服务器所有跑团资产和管理游戏资产的权限，运营者应谨慎分配该角色。

## Bot 会处理哪些信息

### Discord 账号、服务器和身份组数据

启用管理组/中层管理名单功能后，Bot 会使用 Server Members Intent 读取服务器成员和身份组，以筛选管理员配置的管理身份组成员，并处理身份组变更或成员离开事件。非主管理组成员使用普通 `/说话` 提及身份组时，Bot 还会逐页读取服务器成员及其身份组，在内存中计数，以阻止提及超过 100 人的身份组；计数结果不另行持久保存。启用表情反应清理后，Bot 会接收服务器的消息反应事件，并对照管理员设置的作者 ID 和表情 ID/名称；匹配时移除该消息上的该种表情反应。运行数据可能包含服务器、频道、身份组、消息、用户和管理员的 Discord ID，任职/卸任时间、处罚编号、处罚原因、提醒内容和执行状态。启用版务审批时，还会保存申请目标链接及其频道/消息 ID、申请人 ID、投票人 ID、投票选择、票数、审批状态和时间。Bot 账号会从管理组名单中排除。

这些数据用于处罚、撤销、管理组名单、公示、提醒、续禁、表情反应清理和经审批的帖子管理/内容删除等已配置功能。Bot 不读取在线状态；反应清理只检查网关反应事件中的作者/表情信息，不分析消息正文；内容删除申请只读取申请链接指定的目标消息以确认对象，达到审批门槛后才删除。紧急频道功能的聊天记录处理见下文。

### Bot 发言与 Discord 交互

处罚面板可独立配置本服务器额外处罚操作身份组，Bot 会将这些身份组 ID 随服务器配置加密保存，仅用于本服处罚、永封、撤销及预约鉴权，不根据其他服务器成员身份授权。警告和禁言时长可按整分钟设置（最低 1 分钟）；存储仍使用兼容旧记录的天数数值。撤销处罚需填写理由，Bot 保存撤销人 ID、撤销时间和理由；理由显示在配置的处罚公示/留痕频道及 Discord 审计原因中，随既有处罚记录加密存储，无自动删除期限。

启用 `/投票` 后，本服务器真人成员可创建或参与普通/处罚投票，不限制身份组。公开投票消息仅显示选项、票数、截止时间及结果；处罚投票还显示目标、处罚方式和原因，不显示投票人名单、投票人身份或各人的选择。普通投票可配置每人最多选择多个选项，每人每项只计一票；处罚投票仍限二选一。Bot 在内存中按用户 ID 限制选项数量，支持修改和撤回；创建人、投票人及选择、修改/撤回/取消/批准事件、时间和处罚结果仅保存在私密存储服务器 `1554018151094689853` 的频道 `1555055810818605107` 的 AES-256-GCM 加密投票附件中。共享运行数据仅保存投票 ID、频道和记录消息指针、截止时间及状态，不另存投票人名单。存储服务器拥有“管理服务器”权限的成员可在该频道请求仅本人可见的解密文件。投票通过不会自动处罚，须由已配置主管理组或服务器管理员确认；实际处罚及确认人仍进入现有处罚审计记录。投票记录无自动删除期限，用户可联系运营者请求删除。投票消息在 Discord 上显示汇总数量，因此不承诺对能够结合其他信息推断选择的观察者实现绝对匿名。

启用预约处罚后，已配置管理组或中层成员可预约24小时后执行警告、禁言、警告并禁言或永封。Bot 保存预约及处罚编号、目标/发起人/解除人 ID、服务器范围、源/公示频道及消息 ID、原因、时长、执行时间、状态和结果，随运行数据以 AES-256-GCM 加密存储，无自动删除期限。预约公示频道会显示目标、发起人、原因、方式、时间及处理状态。其他有权限的管理组或中层成员可在到期前解除；实际执行仍需符合当时的发起人身份组和 Bot 权限。执行结果不确定时停止自动重试，关闭预约不会撤销已经实际执行的处罚。

中层申请被拒绝时，管理组可在表单中填写或修改拒绝理由，Bot 会私信申请人告知申请结果和理由。默认拒绝理由、实际拒绝理由、处理人 ID、私信发送状态及成功发送后的消息 ID 会随申请记录加密保存。私信、申请人自己的进度页和拒绝审批卡不显示拒绝人身份；处理人 ID 保留在内部加密状态中用于审计。管理员填写理由时应避免主动包含处理人的身份。申请人关闭私信时可能无法投递，Bot 会记录失败并允许管理组重发，申请人也可在原面板查看理由。

本版本上线后审批通过的中层申请，在全部目标身份组发放和状态保存成功后，Bot 按目标身份组逐一私信通过回信，配套身份组不另发信，历史已通过申请不补发。每个服务器按身份组保存共用回信模板，正文最多 2000 字；正式通过时将正文、服务器/面板/身份组名称与身份组 ID 冻结到该申请记录。按申请和身份组记录投递状态、尝试次数、尝试/送达/失败时间及成功投递的私信消息 ID，随运行数据以 AES-256-GCM 加密保存，没有自动删除期限。审批频道显示投递状态，申请人可在仅本人可见的“我的申请”中按身份组读取回信。回信和申请人页面不自动显示审批人身份；管理员应避免在自定义正文中填写须隐藏的身份信息。私信失败不撤销发放，管理组可重发未送达回信；已记录成功的回信不会重复发送，重启后投递结果不确定的回信须确认可能重复投递后手动重发。

启用违规改名面板后，Bot 保存允许操作的身份组、目标必需违规身份组、启停状态和当前昵称锁定记录（目标/操作者 ID、改名理由、违规身份组、时间）。这些设置与记录随服务器状态加密保存。获授权的操作员提交改名后，Bot 将目标服务器昵称改为其数字用户 ID，通过成员更新事件及定期检查保持该昵称；移除指定违规身份组、离服或手动解除锁定后删除该成员的锁定记录并停止自动改回。更换面板中的违规身份组会解除全部已有锁定。暂停功能会保留记录。Bot 不改变账号名或用户数字 ID，不为此保存聊天内容。

启用中层申请面板后，Bot 会保存每套面板的名称、说明、前置/发放身份组列表（发放可多选，最多 10 个）、审批/公开频道、审批票数和已发布消息 ID；还会保存申请人 ID、申请理由、提交时间、申请时的身份组要求、审批人 ID、票数、处理结果和失败说明。这些记录随服务器状态用 AES-256-GCM 加密保存到部署者的 Discord 私密存储频道，没有自动删除期限。理由和审批信息会显示在管理员配置的审批频道，申请人可查看自己的申请状态；部署者应限制审批频道访问。公开申请面板仅显示要求、Discord 官方身份组人数（含 Bot）和待审批人数，不显示申请理由。人数通过身份组人数接口读取，不为此扫描完整成员列表；统计结果只在内存中维护，成员变更事件及定期核对用于更新人数。审批通过后 Bot 补发全部配置的身份组；部分发放失败会保留记录供管理组重试补齐。每个发放身份组分别显示人数，旧单身份组记录继续有效。申请人不能审批自己的申请。

启用 `/冲水面板` 后，主管理组或 ADMIN 可配置操作身份组和豁免频道；实际清理须持有指定操作身份组。经操作者确认，Bot 会分页读取所选范围内的消息元数据，以真实作者 ID 筛选并删除目标用户直接发送的消息，包括附带图片。分页可能读取其他作者消息，但不会删除或留存其内容。Bot 不会将扫描正文、图片或附件复制到持久状态。任务 ID、目标/操作者 ID、继续操作人 ID、选择范围、豁免、首楼开关、时间边界、频道队列、分页游标、删除统计和最多 100 条错误明细随服务器状态加密保存，暂无自动删除期限。删除通过 Discord 消息接口执行，不删除或编辑频道及帖子；删除消息无法恢复。任务重启后暂停，需要有权操作者重新确认才继续。

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

The RPG upgrade stores food/medicine templates, healing dice, condition cures, temporary modifiers and action-count or absolute expiry times in the existing encrypted guild state. Draws publicly disclose the drawing user, item, rarity, description, weight, in-game value, ID and pending-claim status in the command channel; inventory, balances and remaining tickets stay private to the owner and configured GMs. GM checks publicly disclose the task, rule, thresholds, participant, dice and outcome. Scheduled RPG sessions store GM and participant IDs, title, description, start time, source message and per-batch reminder delivery states; at start the bot verifies listed members are still in the guild and mentions them in that channel. These records, saved drafts and audit history have no fixed automatic expiry. Short-lived private-interaction handles remain only in process memory; reopening is required after restart. Ending combat removes usable controls while preserving public results and audit records.

Faction selections, department and change timestamps are stored with the character and shown on public character cards. GM buyback panels privately display the selected player's inventory to configured GMs and store quote drafts, quantities, prices and confirmations. Container draws persist batches of one to six items and delivery state for each public message; a pending batch survives restart without rerolling. These records use the same encrypted storage and audit rules.

Guilds may configure additional punishment-operator role IDs, encrypted with their settings and used only to authorize local punishment, permanent-ban, revocation and scheduling operations. Membership in another server does not authorize these operations. Warning and timeout durations support whole minutes starting at one minute while retaining the existing day-based stored format. Revocation requires a reason; the bot stores the revoking user's ID, time and reason, includes the reason in configured notice/audit channels and Discord audit reasons, and encrypts it with existing case records without automatic expiry.

The `/投票` command permits human guild members to create and vote in ordinary or punishment polls without a role requirement. Public cards display options, aggregate counts, deadlines and results, plus the target, action and reason for punishment polls; they do not display voter identities or individual choices. Ordinary polls may allow multiple selected options per user, counting each option at most once per person; punishment polls remain single-choice. The bot enforces the configured selection limit in memory and supports changing or withdrawing selections. Creator/voter IDs, individual choices, change/withdrawal/cancellation/approval events, timestamps and execution results are stored only in AES-256-GCM encrypted poll attachments in channel `1555055810818605107` of the private storage server `1554018151094689853`. Shared operational state contains pointers, deadlines and status, without voter lists. Members with Manage Server permission in the storage server may request an ephemeral decrypted file from that channel. Passing a punishment poll does not automatically punish: a configured senior manager or guild Administrator must confirm, and actual punishment actions remain covered by the existing moderation audit. Poll records have no automatic deletion period; users may contact the operator for deletion requests. Public aggregate counts may permit inference when combined with other information, so absolute anonymity is not promised.

Configured management and middle-management members may schedule a warning, timeout, combined warning and timeout, or permanent ban after a 24-hour waiting period. The bot stores appointment and punishment IDs, target/operator/cancelling-user IDs, server scope, source/notice channel and message IDs, reason, duration, timestamps, status and results in the AES-256-GCM encrypted operational state, without automatic expiry. The public appointment notice shows the target, operator, reason, action, deadline and status. Authorized members may cancel before the deadline. Execution rechecks the original operator's configured role and the bot's permissions. Ambiguous execution is not automatically retried; closing an appointment does not revoke any punishment already applied.

When a middle-management application is rejected, a reviewer supplies or edits a rejection reason, and the bot sends the applicant a direct message with the result and reason. Default and actual rejection reasons, the internal reviewer ID, delivery status and successful DM message ID are stored with the encrypted application state. The DM, applicant-facing status view and rejected approval card do not display the rejecting reviewer's identity; the ID remains in encrypted state for internal auditing. Reviewers should avoid including identifying information in their free-text reasons. If DMs cannot be delivered, the bot records failure, allows reviewers to resend and keeps the reason available through the applicant's status view.

For middle-management applications approved after this release, the bot sends one approval DM per application award role after all award roles and the completed state have been saved. Companion roles receive no additional DM, and historical completed applications are not backfilled. Each server stores shared, per-role reply templates of up to 2,000 characters. Approval freezes the body, server/panel/role names and role ID in the application record. Per-application and per-role delivery status, attempt count, attempt/delivery/failure timestamps and successful DM message IDs are stored in the AES-256-GCM encrypted operational state, with no automatic expiry. Approval cards show delivery status; applicants can read their own per-role replies through an ephemeral status view even if DMs are closed. Replies and applicant-facing views do not automatically identify reviewers; administrators should avoid adding confidential identities to custom text. Delivery failure does not revoke awarded roles. Reviewers may resend undelivered replies, skipping recorded successes; ambiguous results after interruption require explicit manual confirmation because a duplicate DM may result.

The optional nickname panel stores authorized operator roles, the prerequisite violation role, an enabled flag and current locks containing target/operator IDs, reason, role and time. This state is encrypted with the other operational settings. An authorized operator can rename an eligible member's server nickname to their numeric user ID; the bot maintains that nickname through member updates and periodic checks. The lock is removed when the violation role is removed, the member leaves, or an operator releases it. Changing the configured violation role clears existing locks; pausing preserves them. The bot does not change account usernames or numeric user IDs, or store chat content for this purpose.

When middle-management application panels are enabled, the bot stores panel configuration, applicant IDs and reasons, submission timestamps, prerequisite and award roles, reviewer IDs, approval counts, results and failure details. These records are encrypted with AES-256-GCM as part of the private Discord operational state and have no automatic deletion period. The configured approval channel displays application reasons and review information; applicants can view their own status. Public panels display requirements, Discord-provided award-role member counts (including bots) and pending application counts, without publishing reasons. Counts come from the role-member-count API without scanning the full member list for this purpose. They are held in memory and updated after member changes and periodic reconciliation. Roles are awarded after approval, and applicants cannot approve their own requests.

The `/管理说话` command checks the configured senior management role or server Administrator permission before posting a management announcement. The announcement publicly shows its speaker's Discord ID and message body. Its verification button checks a signature over the body, guild, channel and speaker using a secret that is not posted to Discord. Ordinary `/说话` users cannot create this signed announcement. For both `/说话` and `/管理说话`, the bot first writes an encrypted record to a separate private channel in the same storage server. The private channel shows the operator ID, command, source channel, delivery status and, after success, the bot message link. The message body, reply link, image names and image URLs are encrypted with AES-256-GCM in an attachment; image files themselves are not copied. Storage-server members with Manage Server permission may request a decrypted ephemeral copy. The bot does not send the original message if archive creation fails. These records have no automatic deletion period.

This self-hosted bot processes Discord IDs, configured role membership, appointment history, moderation cases, reminder settings, configured reaction-cleanup rules and (when enabled) content moderation proposal links and approval votes to provide the features administrators enable. It uses the Server Members Intent for configured management rosters and to count role members in memory when a user without the configured senior management role uses ordinary `/说话` to mention a role, rejecting roles with over 100 members without storing the count. It uses the non-privileged Guild Message Reactions intent to compare reaction events with configured message authors and emojis. The `/说话转发` command fetches only a specific same-server message selected by an operator who can view its source channel, then asks Discord to forward it to the current channel or thread. Source message content is not added to the bot's persistent state; the forwarded message remains on Discord under the destination channel's access and retention settings. Some messages cannot be forwarded without Message Content access (Discord error 160014). Authors currently have no in-app self-service opt-out for an individual forward and may contact the operator about a request. The bot does not enable Presence intent or analyze ordinary message text for reaction cleanup. A message may be fetched to complete a partial reaction event, but its content is not stored for that purpose. The `/提问` command and external AI API integration have been removed. Persistent operational state is encrypted with AES-256-GCM before it is uploaded as a bot-authored attachment to the private Discord channel selected by the operator. The encryption key is kept in the operator's local `.env` file or a secrets manager and is not stored in Discord or the public repository. The Bot decrypts state in memory while running. After successful Discord storage, the bot also encrypts its known local legacy state files in place; the encrypted copies remain on the host until the operator deletes them. Legacy Discord-channel messages, separate backups and logs are not automatically removed or encrypted and must be reviewed and protected by the operator. Historical cases, proposals and tenure records have no fixed automatic deletion schedule; records should be removed when no longer needed, and users can request access, correction or deletion by contacting the operator at `xizikangx@gmail.com`. Senior management members may create a private temporary emergency channel for selected roles or for no role; the creator and bot retain access. Managers may invite specific members with permission to view, send, create public threads, react and read message history. On explicit close confirmation, the bot reads up to 5,000 messages from that channel and its threads, including author IDs, timestamps, content, embeds and attachment URLs, encrypts the transcript with AES-256-GCM, and posts it to the configured private Discord record channel before deleting the temporary channel. Attachments themselves are not copied. Case metadata and the reason appear unencrypted in that private record channel. Managers can request a decrypted transcript through an ephemeral interaction. If message content is unavailable or the export fails, the channel remains. Enabling transcript export for ordinary member messages requires Message Content Intent approval covering this use; an earlier application describing only link-selected forwards should not be assumed to cover it. The encrypted record has no automatic deletion schedule. When enabled, punishment cases may be synchronized between the two servers configured by the operator, with records written to each server's configured channels. The operator must verify this policy against the actual deployment and data-sharing settings.

### 探索与死亡记录

房间模板还保存GM配置的容器、散落物资及NPC各数量概率、持久编辑草稿、模板引用与版本。探索实例保存独立抽取的实际数量、生成内容快照及剩余NPC遭遇进度，以避免重启或重复操作重抽。概率及未探索内容仅向配置GM展示，已探索内容按既有地图与物资展示规则公开；沿用AES-256-GCM存储及既有保留、删除规则。

探索功能保存地图大类、房间模板版本、GM布局草稿、地图实例、队员用户ID及角色编号、位置、全队探索记录、钥匙次数、容器结果、领取归属和公示消息编号。未探索内容仅向配置GM展示，公共地图仅显示已揭开格子；领取物资的角色提及与掉落物品公开展示。保险箱六色概率按服务器保存。

NPC死亡保存伤害来源、基础及实得经验、领取者、死亡编号、装备快照、剩余弹药、配件及钥匙次数；人形NPC可拾取实物向参战队伍公开。玩家死亡清除有效角色和可用资产，但死亡前角色快照及交易、骰点、死亡审计保留在加密存档，用于核对与防重复，不会重新成为可用资产。公开战场显示死亡与击杀结算，不展示玩家死亡前的私有背包或余额。上述数据沿用本政策已有的加密存储、访问、保留及删除处理规则。

### 跑团编辑与装备状态

GM文案编辑保存本服务器的规则、世界背景、势力及部门正文，编辑者ID、版本、时间及个人草稿；发布正文可由本服务器成员读取，未发布草稿仅配置GM通过自己的面板操作。此功能仅修改展示文案，不改变权限或计算规则。身份组领取标签、交易报价及NPC数量通过下拉选择记录内部标识。

装备实例保存当前耐久及经修复削减后的独立耐久上限；子弹模板及已装载每发快照保存附加伤害、异常、重量和数值效果，连射记录每发骰点、弹药消耗、护甲削弱和修复结果。私人背包/报价不写入公共卡，战场可公开射击、弹药耗尽及护甲耐久变化。所有新增记录沿用AES-256-GCM私密存档、事务审计及本政策已有保留和删除规则。


### 角色设置与图片（2026-10-06）

GM批量发放记录操作者、所选玩家及角色编号、物品模板版本、数量、批次、实际发放物品编号、完成时间及逐人成功/失败原因，沿用AES-256-GCM加密存档和现有审计保留规则。选择清单、资产相关信息和发放结果仅在操作者的私有GM面板显示，不自动发布到公共频道。

角色可保存本人填写的虚构角色年龄，在公开角色卡显示，不要求提供现实年龄。主手、副手装备与GM单手/双手分类保存为游戏状态，沿用同一加密存档和操作审计。

装备槽位面板仅由角色本人打开，快捷操作保存装备状态及审计，刷新读取最新数据。鉴定技能保存GM录入的名称、初始等级、模板版本，以及角色个人已学技能、等级、技能经验、GM发放和升级记录；个人列表只向本人显示，参与公开鉴定时显示当次技能名称、等级加成、骰点与成败。不自动从使用技能推断或发放经验。所有记录沿用AES-256-GCM私密存档及既有删除规则，销卡时移除个人技能，保留历史审计与鉴定结果。

跑团角色可保存玩家自选性别、个人背景、个人外貌描述、个人信念，以及基础时运、修正效果、属性点分配和操作审计。性别与个人描述在公开角色卡展示；资产访问范围保持原规则。玩家只编辑自己的角色，NPC模板图片由配置GM维护。

玩家与GM上传的头像、立绘分别作为独立AES-256-GCM加密附件保存到私密Discord存储频道；加密存档记录其消息编号、格式、大小与校验值。展示角色卡时Bot在内存解密，以消息附件展示，公开角色卡中的图片可被该频道读者查看或保存。上传、预览、取消、替换、销卡后，已上传的加密附件和历史快照不自动到期，沿用现有联系运营者访问、更正与删除流程；重新建卡不继承旧图片。Bot不将图片提交到公开代码仓库或长期保存为本地明文。

时运和有效掉落概率随已生成结果保存，避免重启或修改后重抽。此次物价迁移一次性清零游戏币余额、重估可用物品并取消未成交报价；保留角色、背包、装备、次数、历史成交、死亡记录和审计。以上均为游戏内数据，不提供现实货币兑换。


### 自动NPC、探索确认与弹夹（2026-10-06）

跑团存档新增NPC控制方式、目标策略、概率草稿、装备预设和独立实例装备，以及自动操作的战斗/行动/步骤编号与结果。全队移动保存参与者Discord用户编号、角色编号、同意或拒绝、有效期、队伍及布局快照、目的地、钥匙消耗和公示发送状态；公共确认卡实际提及参与者，显示确认进度，未探索内容保持隐藏。公开战场地图显示参战者、位置与生命状态，探索地图只展示已探索布局；GM完整布局及私人资产面板不公开。

弹夹/箭匣保存所装弹药的模板快照、类型、数量及重量，记录抽出、填弹、更换及射击消耗。旧载弹一次性迁移，不额外创建弹药。自动操作、移动投票、提醒及装备状态沿用AES-256-GCM私密存储和事务审计，重启恢复，不重复扣资源；保存或发送结果不明确时暂停或由GM核对。图片地图在内存按游戏状态生成，不包含私有背包、余额或抽取次数。上述游戏记录沿用本政策的访问、更正及删除规则。


### 双地图与公开战斗操作（2026-10-07）

跑团存档新增区域/建筑类型、地点通行与内容、绑定及全队往返位置、参与者与确认记录。公共探索只展示已探索位置，GM完整地图仅在私有面板展示。独立战斗技能保存模板编号、版本、角色已学快照及授予/移除审计；迁移旧技能保留吟唱引用，不把技能作为可交易或掉落实物。

NPC保存智能/概率策略、最近决策说明、实际库存补弹结果与单次开局标记。范围攻击保存中心坐标、范围、波及角色编号、独立骰点、防守、异常、HP及死亡/奖励结算。战斗操作和发送状态沿用AES-256-GCM加密存档；公开频道可看到操作者角色、头像、武器/技能、弹药变化、位置、伤害及生命结果，不公开背包、余额、剩余抽取次数或私人配置。常规操作卡不实际提及，必要行动提醒仍按原规则。

地图与特效卡使用内存SVG/PNG及有限缓存，读取现有加密头像并在内存解密规范化，缺失时回退编号；不将真实头像或存档提交至公开仓库。公开地图和卡片图片可被频道读者查看或保存。存档备份保持加密，新增游戏记录适用已有访问、更正、保留和删除规则。

### 六色容器、随机内容与RP（2026-10-07）

跑团存档新增容器档位与六色概率配置、旧保险箱概率备份、现代物资用途标签与归属、地图大类适用类型、房间变种权重及内容覆盖，以及已生成房间、NPC等级/强化/技能和掉落概率快照。预置包导入标记及稳定编号用于保留GM修改和停用，已有玩家资产不因本次扩充重置。

开启RP的地图保存隐藏GM操作频道编号、选定环境草稿、修改版本、等待状态及公开发布的消息编号/发送结果。隐藏频道在配置和发送时检查访问权限；公共等待状态不展示未发布环境或遭遇内容。正式环境描述在探索频道公开，卡片不显示发布GM身份，内部修改与发布仍在加密审计中记录操作者。重启不重新抽取或自动重复不明确的发送。

地图清理保存删除标记、地图名称快照、清理操作者及审计。只移除符合条件的已结束地图布局与未领取内容，停用关联旧按钮；已发放资产、历史经验、战斗和奖励记录继续遵守本政策保留与删除规则。不会删除Discord频道、内容模板或其他队伍数据。以上新增状态沿用AES-256-GCM私密存储；公开卡片及地图可被有频道访问权的人查看或保存，私人资产及GM配置不公开。


### 战斗行动RP、文字卡片与物品图标（2026-10-08）

可选行动RP保存操作者用户编号、角色编号、战斗及行动机会、目标和参数、草稿编号／截止时间、RP正文、实际执行结果及发送状态。草稿和业务记录沿用AES-256-GCM加密数据库及备份；普通6分钟、防守原120秒有效期是执行期限，不代表历史数据自动删除。已执行RP随角色操作卡公开，摘要及完整RP可被有该频道访问权的人查看，原保留、访问、更正及删除流程适用。取消、过期或失败不会发布RP；RP不改变游戏判定、不触发额外提及。连续移动保留每次已提交RP。

文字操作卡保存伤害类型、逐发结果与护甲减免、满骰依据、双血条、关联死亡/奖励及RP。操作卡不再生成GIF或操作图片；历史已发附件依原保留流程，不批量修改。地图、个人状态和物品仍使用本地静态图片。公开范围沿用原战场权限，不增加公开背包、余额或GM私有配置。

物品透明图标由内置图片生成服务根据预置虚构物品描述制作，运行时直接读取随代码发布的本地素材，不把玩家角色、RP、真实头像或存档提交图片生成服务。旧物品按模板编号解析，不重写资产。分类及杂物过滤只调整操作选择范围，不自动删除既有资产或改变掉落。地图装饰根据保存布局确定性绘制，公共迷雾与未发布环境继续隐藏。


### 兑换券、收藏展示、名词与救援（2026-10-08）

兑换池、发布版本、角色绑定券余额、确认草稿、模板版本、实际兑换物品及审计按对象AES-256-GCM加密保存在PostgreSQL和独立备份中。兑换结果私密，仅本人和配置GM可按既有权限查询；实际死亡或销卡清空可用券，新角色不继承，历史审计仍依原政策保留。

收藏柜仅公开本人勾选并仍实际持有的金/红物品名称、数量、描述与既有图标，其他背包和余额不因此公开。转出、消耗或死亡撤展；展示内容可被有访问权的人保存。名词库保存GM草稿、版本及发布状态，只有已发布解释供玩家检索，公开文字不触发额外提及。

BOSS池、冻结怪物和等级、隐藏确认请求、各批次及通知发送意图/核对状态沿用加密存储，确认通知仅发通过权限校验的GM隐藏频道；权限或发送失败不会回退到公开频道。玩家新增正常/倒地生命、版本、异常轮次标记、治疗前后、救援RP、目标、实际治疗量、判死理由和死亡审计。公开战斗面板与操作卡显示生命、倒地/复起及已执行救援叙述，不公开私人资产或未揭示怪物内容。

草稿有效期约束执行资格，不代表历史正文定时删除。新增内容适用原访问、更正、保留及删除流程；日志仅性能元数据，未向运行时图片生成服务发送这些数据。

### 点选移动、批量道具与行商（升级8）

移动草稿记录选点、距离、地形消耗、相关状态指纹和可选敌人编号/位置；批量道具记录数量、同一目标、机会、逐件骰点及双血条/效果结果。失败恢复只读权威存档，不自动重试，期限一次延长且不因刷新续期；历史保留仍遵守原政策。

行商模板、冻结节点货单、收购分类/指定品种、剩余库存/额度、私密报价、买卖数量/标价/总价、角色和操作编号及审计，按对象AES-256-GCM加密保存在PostgreSQL及独立备份中。玩家只在当前已揭示节点查看货单及本人可卖物品/结果，GM可查交易审计，不公开私人背包或未探索节点内容。日志仅必要性能元数据。
