# 发布到公开 GitHub 仓库

## 发布前必须完成

1. 在 Discord Developer Portal 重新生成 Bot Token，并在 API 服务商处轮换 API Key；把新值只填入本机 `.env`。历史截图曾展示过 Bot Token，建议将旧 Token 视为已暴露。不要把新凭据发到聊天、截图或 GitHub。
2. 确认 `PRIVACY.md` 中的运营者联系邮箱是可用且适合公开的。若不希望公开个人邮箱，可先改成专门的服务邮箱。
3. 查看 `git status` 和待提交文件列表，确认 `.env`、`data/`、日志和任何本地备份均未被暂存。

## 创建仓库并推送

1. 登录 GitHub，创建一个空仓库，例如 `discord-api-bot`，选择 **Public**。不要在网页上勾选自动创建 README、`.gitignore` 或 License，因为本地项目已有文件。
2. 在 PowerShell 中进入项目目录：

   ```powershell
   cd "$HOME\Documents\Codex\2026-09-27\gei\outputs\discord-api-bot"
   ```

3. 初始化并检查待提交文件：

   ```powershell
   git init -b main
   git add .
   git status --short
   ```

   列表应只包含公开代码、说明文件和 `.env.example`；不能出现 `.env`、`data/`、`node_modules/` 或个人资料文件。发现不认识的文件时，先运行 `git restore --staged 文件名` 将它从暂存区移除。

4. 提交并连接 GitHub 仓库（把 `OWNER` 换成你的 GitHub 用户名或组织名）：

   ```powershell
   git commit -m "Prepare public release"
   git remote add origin https://github.com/OWNER/discord-api-bot.git
   git push -u origin main
   ```

5. 打开 GitHub 仓库确认 README、隐私政策和审核材料均可见。公开隐私政策地址为 `https://github.com/OWNER/discord-api-bot/blob/main/PRIVACY.md`。然后在 Discord Developer Portal 的应用资料中填写该地址（若表单要求 Privacy Policy URL）。

公开仓库表示任何人都可以查看代码。仓库目前未附加开源 License；公开可见本身不等于授予他人复制、修改或分发代码的许可。
