# 默照 · 部署手册

## 当前部署形态（已生效）

- **服务**：launchd 托管，`~/Library/LaunchAgents/app.mozhao.plist`，开机自启 + 崩溃重拉。plist 的 `EnvironmentVariables` 必须含 `PATH=/opt/homebrew/bin:/usr/bin:/bin`——launchd 默认 PATH 找不到 ffmpeg，whisper 会转写失败
- **端口**：`127.0.0.1:28787`
- **公网入口**：`https://<your-host>.<your-domain>`（用户自管的 Cloudflare named tunnel，指向本机 28787）
- **Bearer token**：`<在 plist 里查看：~/Library/LaunchAgents/app.mozhao.plist>`（在 plist 里；换 token 改 plist 后 `launchctl kickstart -k gui/$(id -u)/app.mozhao`）

## 鉴权设计

| 访问者 | 层 | 机制 |
|---|---|---|
| 人（浏览器/PWA） | Cloudflare Access（边缘） | OTP 到本人邮箱，cookie 会话 |
| 程序（快捷指令/API） | Go 服务（应用层） | `Authorization: Bearer <token>`，`OBS_TOKENS` 逗号分隔可按设备吊销 |
| 本地开发 | 同上 | `http://localhost:28787`，首次弹 token 卡输入一次即存 localStorage |

**Access OTP 配置**（Zero Trust 后台，一次性）：

1. Access → Applications → Add → Self-hosted
2. Subdomain `mozhao`，Domain `<your-domain>`，Session 时长建议 1 个月
3. Policy：Allow → Include `Emails` → 你的邮箱
4. 保存后访问 https://<your-host>.<your-domain> 验证：输邮箱 → 收验证码 → 进入

PWA 与 API 同源，Access cookie 自动覆盖页面内所有 fetch。

## iPhone 收尾

1. Safari 打开 https://<your-host>.<your-domain>（过一次 OTP）→ 分享 → 添加到主屏幕
2. 快捷指令「语音记」：系统录音 → POST `https://<your-host>.<your-domain>/api/capture`
   - multipart：文件字段 `audio`，字段 `id`（26 位随机大写字母数字）、`src=shortcut-audio`
   - 标头 `Authorization: Bearer <token>`；通知只显示「已封存」
   - 设置 → 辅助功能 → 触控 → 背面轻点两下 → 绑定
3. 快捷指令「记一条」：POST JSON `{"id":"…","text":"…","src":"shortcut-text"}`，同标头

注意：Access 默认拦截无 cookie 的请求——快捷指令域名要走 Access 的 **Service Auth**，或者把 `/api/*` 在 Access 里设一条 Bypass 策略（API 有 Bearer 兜底，安全不降级）。推荐后者：Access policy 加一条 `Bypass`，路径包含 `/api/`。

## 维护

```bash
# 重启服务
launchctl kickstart -k gui/$(id -u)/app.mozhao
# 前端/后端更新后重新部署
cd ~/lab/observer/web && npm run build && cd .. && go build -o mozhao . && launchctl kickstart -k gui/$(id -u)/app.mozhao
# 备份
curl -H "Authorization: Bearer <token>" https://<your-host>.<your-domain>/api/export -o backup.zip
# 日志
tail -f ~/lab/observer/data/server.log
```

转写默认本地 whisper（M5 实测约 5 倍实时）。

## 云端转写（Cloudflare Workers AI）

引擎链：`OBS_STT_ENGINE=cf` 时云端 whisper-large-v3-turbo 优先、本地 whisper 兜底；不配则本地优先、云端兜底；凭据缺失时云端自动跳过，不致命。落库事件的 `engine` 字段记实际出力的引擎。

**配置步骤（凭据只进 plist，不落仓库）：**

1. CF dashboard → 左侧 **AI** → **Workers AI**，确认已开通（免费额度 10k neurons/日；whisper-large-v3-turbo 约 46 neurons/分钟，折合每天约 200 分钟免费转写，日常远用不完）
2. 右上头像 → **My Profile** → **API Tokens** → Create Token → 用 **Workers AI** 模板（或自定义：Account / Workers AI / Read 权限，Account Resources 选本账户）→ Create，**复制 token（只显示一次）**
3. 同页或 dashboard 右侧栏复制 **Account ID**（32 位十六进制）
4. 编辑 `~/Library/LaunchAgents/app.mozhao.plist` 的 `EnvironmentVariables`，加三项：
   - `OBS_STT_ENGINE` = `cf`
   - `OBS_CF_ACCOUNT_ID` = 第 3 步的 Account ID
   - `OBS_CF_API_TOKEN` = 第 2 步的 token
5. 重载（plist 环境变量改动必须 bootout 才生效，kickstart 不够）：
   ```bash
   launchctl bootout gui/$(id -u)/app.mozhao && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.mozhao.plist
   ```
6. 验证：启动日志应从「云端转写兜底禁用」变为正常就绪；录一条后 `data/log-*.jsonl` 里 transcript 事件的 `engine` 应为 `cf`
