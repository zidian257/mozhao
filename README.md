# 默照

语音记录工具：每条记录封存 10 天后才可回看。本地管道，两端只有「记」和「看」。

## 快速开始

```bash
scripts/install-sensevoice.sh        # 一次性：编译转写引擎 + 下载模型（~448MB）
cd web && npm install && npm run build && cd ..
go build -o mozhao .
OBS_TOKENS=dev ./mozhao             # http://localhost:8787
```

调试封存窗口：`OBS_SEAL_WINDOW=10s ./mozhao`（默认 240h = 10 天）。

## 开发

- 后端：`go test ./...`；前端：`cd web && npm run dev`（proxy /api → :8787，可用 `OBS_API_TARGET` 覆盖；`npm run mock` 起契约 mock）
- 改前端后需 `npm run build && go build` 才进二进制（embed）

## 文档

- `docs/api-contract.md` — 前后端契约（事件模型 / API / 封存规则），改行为先改它
- `docs/deploy.md` — 隧道、Access OTP、pm2 托管、iPhone 快捷指令部署手册
- 产品方案：《观测者-产品技术方案》（设计红线：不评价、不催促、不记分）

## 配置（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OBS_PORT` | 8787 | 监听端口 |
| `OBS_DATA_DIR` | ./data | JSONL + 附件 |
| `OBS_TOKENS` | （空=开发模式，全放行） | Bearer token，逗号分隔，按设备吊销 |
| `OBS_SEAL_WINDOW` | 240h | 封存窗口（调试可 10s） |
| `OBS_STT_ENGINE` | whisper | 转写引擎链：`whisper`（本地 whisper.cpp + large-v3-turbo 优先，CF 兜底）/ `cf`（Workers AI 云端优先，本地 whisper 兜底）/ `sensevoice`（轻量本地引擎） |
| `OBS_WHISPER_BIN` / `OBS_WHISPER_MODEL` | vendor 默认路径 | 本地转写（Metal） |
| `OBS_SENSEVOICE_BIN` / `OBS_SENSEVOICE_MODEL` | vendor 默认路径 | 本地转写（可选引擎） |
| `OBS_CF_ACCOUNT_ID` / `OBS_CF_API_TOKEN` | （空=跳过云端） | Workers AI whisper-large-v3-turbo；`cf` 引擎链必需 |
| `OBS_HOTWORDS` | （可选） | 热词表路径（仅 sensevoice 引擎；待上游支持传参） |
