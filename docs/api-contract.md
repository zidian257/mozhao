# 默照 · 前后端契约（M1 唯一事实源）

两端施工都以本文件为准。改契约必须同步改本文件。

## 事件模型（JSONL，append-only）

存储目录 `data/`（env `OBS_DATA_DIR`，默认 `./data`）。按月切分 `log-YYYY-MM.jsonl`（按月界的 `ts` 归属），附件放 `attachments/YYYY-MM/`。所有时间 RFC3339 带偏移（如 `2026-09-18T21:03:11+08:00`）。每行一个 JSON 对象，字段：

```jsonl
{"id":"01J…","ts":"…","type":"voice","media":"attachments/2026-09/01J….m4a","dur":112,"src":"pwa"}
{"id":"01J…","ts":"…","type":"text","body":"…","src":"shortcut-text"}
{"type":"transcript","ref":"01J…","ts":"…","text":"…","engine":"sensevoice","segments":[{"t":0.96,"d":4.22,"text":"…"}]}
{"type":"edit","ref":"01J…","ts":"…","body":"…"}
{"type":"delete","ref":"01J…","ts":"…"}
```

- `id`：ULID，**客户端生成**，服务端幂等去重（同 id 重复 capture 返回 200 同 id，不重复落盘）。
- `type`：`voice | text | transcript | edit | delete`。`ref` 指向 entry id。
- `dur`：秒（float）。`src`：`pwa | shortcut-audio | shortcut-text`。
- `engine`：`whisper | sensevoice | cf-whisper`（失败记 `failed`）。`segments` 为句级时间戳（秒），M2 逐词用。
- 读侧折叠：entry 的最终文本 = 最新 edit.body ?? transcript.text ?? text.body ?? null；有 delete 事件的 entry 对 API 不可见（附件不删）。

## 封存规则（服务端裁定）

- `unlocked = now >= entry.ts + SEAL_WINDOW`。`SEAL_WINDOW` 来自 env `OBS_SEAL_WINDOW`（Go duration，默认 `240h`，调试 `10s`）。
- 锁定期间：entries/search/media 一律不可见（404 语义）；仅两个例外——
  - **校对窗口**：entry 创建后 1 小时内（`now - ts < 1h`），允许 `GET …/transcript` 与 `PATCH`（对应校对页"只给看字、可改错字"）。
  - `GET /api/status` 只暴露计数。
- 文本条目（type=text）无 transcript，同样按 ts 封存。

## API（全部 JSON；除静态资源外均走 Bearer）

| 方法/路径 | 请求 | 响应 | 说明 |
|---|---|---|---|
| `POST /api/capture` | multipart：`audio` 文件 + 字段 `id,dur,src`；或 JSON `{"id","text","src"}` | `200 {"id":"…","dedup":false}` | 扩展名按 Content-Type 定（m4a/mp4/webm/ogg/wav）；非法 id 400；同 id 重传 `dedup:true` |
| `GET /api/entries?cursor=&limit=` | cursor 为上一页最后条 `ts\|id` | `{"entries":[…],"next_cursor":"…\|…"}` | 仅已解锁，新→旧，limit 默认 30 上限 100 |
| `GET /api/entries/:id` | — | entry 对象 / 404 | 仅已解锁 |
| `GET /api/entries/:id/transcript` | — | `{"status":"pending\|done\|failed","text":"…"}` / 404 | 校对窗口内或已解锁可见 |
| `PATCH /api/entries/:id` | `{"body":"…"}` | `204` | 追加 edit；校对窗口内或已解锁 |
| `DELETE /api/entries/:id` | — | `204` | tombstone；校对窗口内（校对页「丢弃」）或已解锁 |
| `GET /api/search?q=` | — | `{"entries":[…]}` | 仅已解锁，子串匹配折叠后文本 |
| `GET /api/status` | — | `{"sealed_count":N,"unlocked_count":M,"has_unlocked":bool,"seal_window":"240h"}` | 无任何内容信息 |
| `GET /api/entries/:id/media` | — | 音频流（正确 Content-Type）/ 404 | 仅已解锁 |
| `GET /api/export` | — | `application/zip` 流（jsonl + attachments） | M1 可实现可后置 |

entry 对象形状：`{"id","ts","type":"voice|text","media":url|null,"dur":n|null,"text":string|null,"src":"…"}`（text 为折叠后结果）。

## 鉴权与配置

- 中间件：`Authorization: Bearer <token>` 匹配 env `OBS_TOKENS`（逗号分隔，多 token 便于按设备吊销）。`OBS_TOKENS` 为空 = 开发模式全放行（仅 localhost 用，文档/启动日志要明确警告）。静态资源不鉴权（PWA 壳要能被 Access 拦在更外层；本地开发直接打开）。
- env 汇总：`OBS_PORT`(默认 8787)、`OBS_DATA_DIR`、`OBS_TOKENS`、`OBS_SEAL_WINDOW`、`OBS_STT_ENGINE`(`whisper` 默认，本地优先 | `cf`，云端优先 | `sensevoice`)、`OBS_WHISPER_BIN`、`OBS_WHISPER_MODEL`、`OBS_SENSEVOICE_BIN`、`OBS_SENSEVOICE_MODEL`、`OBS_HOTWORDS`(可选，仅 sensevoice 引擎)、`OBS_CF_ACCOUNT_ID`+`OBS_CF_API_TOKEN`（`cf` 链必需；本地引擎链下作为兜底）。

## 转写流水线（后端内部）

1. capture 落 voice 事件 → 立即返回 id，后台 goroutine 转写。
2. ffmpeg 转 16k mono wav（`-ar 16000 -ac 1`，tmp 文件，用完删）。
3. 引擎链（`OBS_STT_ENGINE` 选择）：
   - **whisper（默认，本地优先）**：`whisper-cli -m $OBS_WHISPER_MODEL -f wav -t 4 -l auto --no-prints -oj -of <tmp>`，解析输出 JSON 的 `transcription[].offsets`（毫秒→秒）得句级 segments，剥掉 `[_BEG_]` 类特殊 token 与首尾空白；超时 240s（large-v3-turbo 首次 Metal 着色器编译较慢）。实测 M5：约 5 倍实时 + ~2s 模型装载。失败 → CF 兜底。
   - **cf（云端优先）**：POST 音频到 CF Workers AI `@cf/openai/whisper-large-v3-turbo`（multipart，`Authorization: Bearer $OBS_CF_API_TOKEN`）；失败/未配置 → 本地 whisper 兜底。
   - **sensevoice（轻量本地）**：`sense-voice-main -m $OBS_SENSEVOICE_MODEL -f wav -t 4 -l auto -itn`；stdout 行形如 `[0.96-5.18] <|zh|><|NEUTRAL|><|Speech|><|withitn|>文本`——剥掉 `<|…|>` 标签；超时 120s。失败 → CF 兜底。
   失败判定：非零退出/超时/空文本。全部失败 → 记 transcript 事件 `engine:"failed", text:""`（status 映射 failed，可重试）。
   注意：CF 路径只回全文 text，无 segments（M2 逐词呼吸对 cf-whisper 条目需句内均摊或重新本地转写补齐）。
4. 成功 → 追加 transcript 事件。

## 前端（PWA）必须遵守

- 技术：Vite + 原生 TypeScript，**无框架无 UI 库**，构建到 `web/dist`（Go embed 的目标）。dev 时 `vite --port 5173`，proxy `/api` → `localhost:8787`。
- 录音：`MediaRecorder` mimeType 探测顺序 `audio/mp4` → `audio/webm;codecs=opus` → 默认；`pointerdown` 启动；`navigator.wakeLock.request('screen')` 录音中持有；ULID 前端生成（自实现，无依赖）。
- 上传成功回 200 即认为已封存；失败进 IndexedDB 队列（`online`/`visibilitychange` flush，同 id 幂等）。
- 校对页：capture 后轮询 `GET …/transcript` 直到 done/failed；failed 显示"转写失败，仍可封存"。**不给重听**。
- 离开即封存：校对页 `visibilitychange`/`pagehide` 时若尚未封存/丢弃，视为封存（条目其实早已落库，这里只是 UI 收尾）。
- 动效规格、色彩、文案词表严格按《观测者-产品技术方案》§3（深色、单一 muted 青蓝强调色、红色只出现在录音点、`prefers-reduced-motion` 降级）。
- M1 不含时间线 UI（M2 做），但 `GET /api/status` 要轮询（每 30s + 封存后）。
- 底部常驻行：每次打开随机显示一句内置佛学箴言（`status.ts` VERSES，crypto 随机，无引号出处）；本 session 内完成一次封存后交叉淡化为"已封存 N 条"并保持到关闭，下次打开回到箴言。401/离线降级同样落回箴言。（2026-09 起取代旧词表的"随手即忘"/"从第一句话开始"，产品所有者拍板）
