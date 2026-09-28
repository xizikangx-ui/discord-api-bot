# Discord Server Members Intent Application

Use this material only if the Developer Portal says this application needs review. Discord currently uses a threshold of 10,000 unique users who can access the app across its servers. Below that threshold, the intent can be enabled in the portal without a review. Confirm the current notice in the Developer Portal before submitting.

## Intent requested

**Server Members Intent (Guild Members).**

Do not request Message Content or Presence for this bot. The current code does not enable either intent and does not need them for its features.

## Use case and necessity

> This application uses the Server Members Intent only for its opt-in management roster feature. A server administrator selects the management role or roles and the roster and announcement channels in the bot's in-server configuration panel. To initialize or refresh a roster, the bot requests the guild member list, then keeps only human members who hold one of the administrator-selected roles. Bot accounts are excluded. The bot records the relevant Discord user and role IDs and appointment start and end timestamps so it can display the current roster and publish appointment and resignation notices. While running, it uses member role-update and member-removal events to keep the configured roster current.
>
> The full member list is necessary to initialize the roster from members who already hold the selected role and to reconcile the current roster after a restart. Slash commands, buttons, and modals cannot provide a complete and current list of everyone who holds an administrator-selected role, nor can they replace the member-update and member-removal events used for ongoing synchronization. The bot does not use this intent to read messages, monitor online status, or create general member profiles. The feature is disabled until a server administrator configures it.

## Data stored outside Discord

**Answer: Yes.**

> The self-hosted bot stores limited operational data on the machine controlled by the bot operator. For the Server Members Intent feature, this includes the guild, role, channel, and user IDs needed to configure and maintain management rosters, plus appointment start and end timestamps. Other enabled bot features also store their own operational settings and records, including reminder settings and moderation case records. The updated implementation encrypts these JSON files at rest with AES-256-GCM using a deployment-specific key stored in the operator's `.env` file; the key is not included in the repository and must be backed up separately. The data is kept under the deployment's `data/` directory and is not sent to the source-code repository maintainer. Historical roster and moderation records are not automatically purged on a fixed schedule. Access to the host, key, and backups is controlled by the operator. The operator can remove the local files to delete stored data, but deleting a shared settings file also removes other configuration and records. The operator's privacy policy and contact address are available at https://github.com/xizikangx-ui/discord-api-bot/blob/main/PRIVACY.md.

> Separately, when a user explicitly submits a question through the bot's AI question interaction, that submitted text and a bounded in-memory conversation history are sent to the API service configured by the operator. This feature is not the reason for requesting the Server Members Intent.

## Evidence links

Provide a short, unedited video or screenshots showing the real bot and the feature in a test server. Use a YouTube **Unlisted** video link so reviewers can view it without making it publicly searchable. Do not use a fabricated mock-up as evidence.

**Demo video:** [Paste the Unlisted YouTube URL here]

**Public source code:** https://github.com/xizikangx-ui/discord-api-bot

**Privacy policy:** https://github.com/xizikangx-ui/discord-api-bot/blob/main/PRIVACY.md

## Video recording outline

Suggested length: 2–3 minutes. Record in a private test server with consenting test accounts. Do not show real member names, private channels, real disciplinary records or reasons, application secrets, tokens, API keys, `.env` files, or private server IDs.

### Screen sequence

1. Show the bot installed in the test server and the management roster configuration panel. Show the administrator-selected test role and roster channel.
2. Show the test role's member list. Demonstrate that the bot's roster contains human members with that role and excludes bot accounts.
3. Add the test role to a consenting test account and show the roster update and appointment notice. Remove the role and show the roster update and resignation notice.
4. Show that the bot's commands are slash-command interactions. Do not demonstrate or claim message scanning.
5. Show the Developer Portal's Privileged Gateway Intents section with Server Members enabled and Message Content and Presence disabled. Keep the token and credentials off screen.

If a step cannot be demonstrated in the current deployed version, omit it and correct the application text rather than implying that it works.

## English narration script

> This video demonstrates the Server Members Intent use case for this Discord application. The feature is an opt-in management roster configured by a server administrator.
>
> The administrator selects the management role and the channels used for the live roster and appointment announcements. When the roster is initialized, the bot fetches the server member list, filters it to human members who have the selected role, and excludes bot accounts. It records only the identifiers and appointment dates needed to maintain and display this roster.
>
> I am now adding the test management role to a consenting test account. The bot detects the role update and updates the roster. I am removing the role, and the bot records the end of the appointment and updates the roster again.
>
> This requires the Server Members Intent because the bot must initialize the roster for members who already have the configured role and receive member role-update and removal events. Slash commands and modals cannot provide a complete current list or replace those events. The bot does not read ordinary messages or presence data. Message Content and Presence are not requested.
>
> The roster configuration and appointment records are stored as local operational data on the bot operator's host. The public privacy policy explains the data, storage, and deletion process.

## Before submitting

- Check whether the portal actually requires review for this app; user count is based on unique users with access across all installed servers, not the number of servers.
- Confirm that the Developer Portal and deployed code both enable Server Members Intent.
- Confirm the test video shows the current deployed code and a real end-to-end roster update.
- Replace the demo-video placeholder with the Unlisted YouTube URL.
- Make sure the privacy policy accurately describes the actual host, backup access, API provider, data retention, and contact details for this deployment.
- State that JSON files are encrypted only after the updated version has been started successfully and has migrated the existing files.
- Do not state that historical data is automatically deleted on a fixed schedule; the current code does not do that.

## Official guidance

- https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review
- https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents
