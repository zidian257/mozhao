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

转写默认本地 whisper（M5 实测约 5 倍实时）。要切云端：plist 里加 `OBS_CF_ACCOUNT_ID` / `OBS_CF_API_TOKEN`，并把 `OBS_STT_ENGINE` 设为 `cf`。
