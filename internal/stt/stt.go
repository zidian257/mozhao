// Package stt 实现契约 §转写流水线：
// ffmpeg 转 16k mono wav → 本地引擎（默认 whisper.cpp + large-v3-turbo，
// OBS_STT_ENGINE=sensevoice 可切 SenseVoice-Small）→ 失败且有 CF 凭据时
// 兜底 Workers AI whisper-large-v3-turbo → 再失败返回 error，
// 由调用方落 engine="failed" 的 transcript 事件。
package stt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 引擎名，与 transcript 事件的 engine 字段一致。
// EngineCF 是选择器（OBS_STT_ENGINE=cf）：云端 Workers AI 优先，
// 本地 whisper 兜底；落库事件的 engine 仍记实际出力的引擎。
const (
	EngineWhisper    = "whisper"
	EngineSenseVoice = "sensevoice"
	EngineCFWhisper  = "cf-whisper"
	EngineCF         = "cf"
)

// 本地引擎默认超时。sensevoice 按契约 120s；whisper 放宽到 240s——
// large-v3-turbo 首次运行要编译 Metal 着色器，冷启动明显更慢。
const (
	DefaultSenseVoiceTimeout = 120 * time.Second
	DefaultWhisperTimeout    = 240 * time.Second
)

// Segment 是句级转写时间戳（秒）。
type Segment struct {
	T    float64
	D    float64
	Text string
}

// Result 是一次成功转写的产物；Engine 为 whisper | sensevoice | cf-whisper。
type Result struct {
	Text     string
	Engine   string
	Segments []Segment
}

// Transcriber 持有一条「选中本地引擎 → CF 兜底」的引擎链配置。
// 二进制/模型缺失或 CF 凭据为空不致命——对应引擎直接跳过，
// 全部不可用时 Transcribe 返回 error。
type Transcriber struct {
	Engine          string // whisper（默认）| sensevoice（OBS_STT_ENGINE）
	WhisperBin      string // whisper-cli 路径（OBS_WHISPER_BIN）
	WhisperModel    string // ggml 模型路径（OBS_WHISPER_MODEL）
	SenseVoiceBin   string // sense-voice-main 路径（OBS_SENSEVOICE_BIN）
	SenseVoiceModel string // SenseVoice GGUF 模型路径（OBS_SENSEVOICE_MODEL）
	Hotwords        string // 热词文件（OBS_HOTWORDS，可选，仅 sensevoice 引擎使用）
	Threads         int    // 本地引擎线程数，默认 4
	Timeout         time.Duration
	CFAccountID     string // OBS_CF_ACCOUNT_ID
	CFToken         string // OBS_CF_API_TOKEN
	HTTPClient      *http.Client
	Logf            func(format string, args ...any)
}

func (t *Transcriber) logf(format string, args ...any) {
	if t.Logf != nil {
		t.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (t *Transcriber) engine() string {
	if t.Engine == "" {
		return EngineWhisper
	}
	return t.Engine
}

func (t *Transcriber) localPaths() (bin, model string) {
	if t.engine() == EngineSenseVoice {
		return t.SenseVoiceBin, t.SenseVoiceModel
	}
	// cf 选择器的本地兜底也是 whisper。
	return t.WhisperBin, t.WhisperModel
}

func (t *Transcriber) timeout(d time.Duration) time.Duration {
	if t.Timeout > 0 {
		return t.Timeout
	}
	return d
}

// Ready 报告当前引擎链的就绪情况（启动日志用）。不就绪不致命：
// 转写时逐项跳过，全部不可用则记 failed。
func (t *Transcriber) Ready() (msg string, ok bool) {
	name := t.engine()
	if name == EngineCF {
		cf := "cf 凭据缺失"
		ok := false
		if t.CFAccountID != "" && t.CFToken != "" {
			cf = "cf 已配置"
			ok = true
		}
		if _, wok := t.localReady(); wok {
			return fmt.Sprintf("stt 引擎 cf（云端优先）：%s；本地兜底 whisper 就绪", cf), true
		}
		return fmt.Sprintf("stt 引擎 cf（云端优先）：%s；本地兜底 whisper 未就绪", cf), ok
	}
	return t.localReady()
}

// localReady 检查当前本地引擎（或 cf 的本地兜底）的二进制/模型。
func (t *Transcriber) localReady() (string, bool) {
	name := t.engine()
	if name == EngineCF {
		name = EngineWhisper
	}
	bin, model := t.localPaths()
	var missing []string
	if bin == "" {
		missing = append(missing, "bin 未配置")
	} else if _, err := os.Stat(bin); err != nil {
		missing = append(missing, "bin 不存在: "+bin)
	}
	if model == "" {
		missing = append(missing, "model 未配置")
	} else if _, err := os.Stat(model); err != nil {
		missing = append(missing, "model 不存在: "+model)
	}
	if len(missing) > 0 {
		return fmt.Sprintf("stt 引擎 %s 未就绪（%s）", name, strings.Join(missing, "；")), false
	}
	return fmt.Sprintf("stt 引擎 %s 就绪（bin=%s model=%s）", name, bin, model), true
}

// Transcribe 按引擎链转写：cf 选择器 = CF 优先、本地 whisper 兜底；
// 本地引擎选择器 = 本地优先、CF 兜底。全部失败返回 error。
func (t *Transcriber) Transcribe(ctx context.Context, audioPath string) (Result, error) {
	var errs []string
	tryCF := func() (Result, bool) {
		if t.CFAccountID == "" || t.CFToken == "" {
			return Result{}, false
		}
		res, err := t.transcribeCF(ctx, audioPath)
		if err != nil {
			t.logf("stt: cf-whisper failed: %v", err)
			errs = append(errs, "cf-whisper: "+err.Error())
			return Result{}, false
		}
		return res, true
	}
	tryLocal := func() (Result, bool) {
		eng := t.engine()
		if eng == EngineCF {
			eng = EngineWhisper
		}
		bin, model := t.localPaths()
		if bin == "" || model == "" {
			errs = append(errs, eng+": bin/model 未配置")
			return Result{}, false
		}
		if _, err := os.Stat(bin); err != nil {
			t.logf("stt: %s bin not found: %s", eng, bin)
			errs = append(errs, eng+": bin not found")
			return Result{}, false
		}
		var res Result
		var err error
		if eng == EngineSenseVoice {
			res, err = t.transcribeSenseVoice(ctx, audioPath)
		} else {
			res, err = t.transcribeWhisper(ctx, audioPath)
		}
		if err != nil {
			t.logf("stt: %s failed: %v", eng, err)
			errs = append(errs, eng+": "+err.Error())
			return Result{}, false
		}
		return res, true
	}

	if t.engine() == EngineCF {
		if res, ok := tryCF(); ok {
			return res, nil
		}
		if res, ok := tryLocal(); ok {
			return res, nil
		}
	} else {
		if res, ok := tryLocal(); ok {
			return res, nil
		}
		if res, ok := tryCF(); ok {
			return res, nil
		}
	}
	if len(errs) == 0 {
		errs = append(errs, "no engine configured")
	}
	return Result{}, errors.New("all engines failed: " + strings.Join(errs, "; "))
}

func (t *Transcriber) threads() int {
	if t.Threads > 0 {
		return t.Threads
	}
	return 4
}

// transcribeWhisper：ffmpeg → 16k mono wav → whisper-cli，解析 -oj 输出 JSON。
func (t *Transcriber) transcribeWhisper(ctx context.Context, audioPath string) (Result, error) {
	wav, err := t.toWav(ctx, audioPath)
	if err != nil {
		return Result{}, err
	}
	defer os.Remove(wav) //nolint:errcheck

	dir, err := os.MkdirTemp("", "mozhao-whisper-")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(dir) //nolint:errcheck
	prefix := filepath.Join(dir, "out")

	ctx, cancel := context.WithTimeout(ctx, t.timeout(DefaultWhisperTimeout))
	defer cancel()
	args := []string{
		"-m", t.WhisperModel, "-f", wav,
		"-t", strconv.Itoa(t.threads()), "-l", "auto",
		"--no-prints", "-oj", "-of", prefix,
	}
	cmd := exec.CommandContext(ctx, t.WhisperBin, args...)
	if _, err := cmd.Output(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return Result{}, fmt.Errorf("timeout after %s", t.timeout(DefaultWhisperTimeout))
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return Result{}, fmt.Errorf("exit %d: %s", ee.ExitCode(), truncate(string(ee.Stderr), 300))
		}
		return Result{}, err
	}
	data, err := os.ReadFile(prefix + ".json")
	if err != nil {
		return Result{}, fmt.Errorf("read whisper json: %w", err)
	}
	return parseWhisperJSON(data)
}

// transcribeSenseVoice：ffmpeg → 16k mono wav → sense-voice-main，解析 stdout。
func (t *Transcriber) transcribeSenseVoice(ctx context.Context, audioPath string) (Result, error) {
	wav, err := t.toWav(ctx, audioPath)
	if err != nil {
		return Result{}, err
	}
	defer os.Remove(wav) //nolint:errcheck

	ctx, cancel := context.WithTimeout(ctx, t.timeout(DefaultSenseVoiceTimeout))
	defer cancel()
	args := []string{
		"-m", t.SenseVoiceModel, "-f", wav,
		"-t", strconv.Itoa(t.threads()), "-l", "auto", "-itn",
	}
	cmd := exec.CommandContext(ctx, t.SenseVoiceBin, args...)
	// TODO(hotwords): sensevoice.cpp 当前没有热词命令行参数（--prompt 语义不同）。
	// OBS_HOTWORDS 文件存在时先以环境变量 SENSEVOICE_HOTWORDS 传给子进程，
	// 待上游支持热词参数后改为 CLI 传参；不阻塞主流程。
	if t.Hotwords != "" {
		if _, err := os.Stat(t.Hotwords); err == nil {
			cmd.Env = append(os.Environ(), "SENSEVOICE_HOTWORDS="+t.Hotwords)
		}
	}
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return Result{}, fmt.Errorf("timeout after %s", t.timeout(DefaultSenseVoiceTimeout))
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return Result{}, fmt.Errorf("exit %d: %s", ee.ExitCode(), truncate(string(ee.Stderr), 300))
		}
		return Result{}, err
	}
	segs := parseSenseVoiceOutput(string(out))
	if len(segs) == 0 {
		return Result{}, errors.New("no segments in output")
	}
	var b strings.Builder
	for _, s := range segs {
		b.WriteString(s.Text)
	}
	return Result{Text: b.String(), Engine: EngineSenseVoice, Segments: segs}, nil
}

// toWav 用 ffmpeg 转出 16kHz 单声道 wav 临时文件。
func (t *Transcriber) toWav(ctx context.Context, src string) (string, error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return "", errors.New("ffmpeg not found in PATH")
	}
	tmp, err := os.CreateTemp("", "mozhao-*.wav")
	if err != nil {
		return "", err
	}
	path := tmp.Name()
	tmp.Close() //nolint:errcheck

	ctx, cancel := context.WithTimeout(ctx, t.timeout(DefaultSenseVoiceTimeout))
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-loglevel", "error", "-y", "-i", src,
		"-ar", "16000", "-ac", "1", "-f", "wav", path)
	out, err := cmd.CombinedOutput()
	if err != nil {
		os.Remove(path) //nolint:errcheck
		return "", fmt.Errorf("ffmpeg: %v: %s", err, truncate(string(out), 300))
	}
	return path, nil
}

// ---------- whisper.cpp 输出解析 ----------

// whisperJSON 是 whisper-cli -oj 输出文件的结构（只取需要的字段）。
type whisperJSON struct {
	Transcription []struct {
		Offsets struct {
			From int64 `json:"from"`
			To   int64 `json:"to"`
		} `json:"offsets"`
		Text string `json:"text"`
	} `json:"transcription"`
}

// whisperTokenRe 匹配 [_BEG_]、[_TT_150] 之类不应进入文本的特殊 token。
var whisperTokenRe = regexp.MustCompile(`\[_+[A-Za-z0-9_]*\]`)

// parseWhisperJSON 把 whisper-cli 的 JSON 输出折成契约的句级 segments
// （offsets 毫秒 → 秒），剥掉特殊 token 与首尾空白；空文本视为失败。
func parseWhisperJSON(data []byte) (Result, error) {
	var w whisperJSON
	if err := json.Unmarshal(data, &w); err != nil {
		return Result{}, fmt.Errorf("bad whisper json: %w", err)
	}
	var segs []Segment
	var full strings.Builder
	for _, seg := range w.Transcription {
		cleaned := whisperTokenRe.ReplaceAllString(seg.Text, "")
		full.WriteString(cleaned)
		text := strings.TrimSpace(cleaned)
		if text == "" {
			continue
		}
		segs = append(segs, Segment{
			T:    float64(seg.Offsets.From) / 1000,
			D:    float64(seg.Offsets.To-seg.Offsets.From) / 1000,
			Text: text,
		})
	}
	text := strings.TrimSpace(full.String())
	if len(segs) == 0 || text == "" {
		return Result{}, errors.New("empty transcription")
	}
	return Result{Text: text, Engine: EngineWhisper, Segments: segs}, nil
}

// ---------- sensevoice 输出解析 ----------

var (
	segLineRe = regexp.MustCompile(`^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s*(.*)$`)
	tagRe     = regexp.MustCompile(`<\|[^|]*\|>`)
)

// parseSenseVoiceOutput 解析 sense-voice-main stdout，行形如：
// [0.96-5.18] <|zh|><|NEUTRAL|><|Speech|><|withitn|>文本
// 剥掉 <|…|> 标签，得到句级 segments。
func parseSenseVoiceOutput(out string) []Segment {
	var segs []Segment
	for _, line := range strings.Split(out, "\n") {
		m := segLineRe.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		start, _ := strconv.ParseFloat(m[1], 64)
		end, _ := strconv.ParseFloat(m[2], 64)
		text := strings.TrimSpace(tagRe.ReplaceAllString(m[3], ""))
		if text == "" {
			continue
		}
		segs = append(segs, Segment{T: start, D: end - start, Text: text})
	}
	return segs
}

// transcribeCF 兜底：multipart 上传音频到 CF Workers AI whisper-large-v3-turbo。
func (t *Transcriber) transcribeCF(ctx context.Context, audioPath string) (Result, error) {
	f, err := os.Open(audioPath)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("audio", filepath.Base(audioPath))
	if err != nil {
		return Result{}, err
	}
	if _, err := io.Copy(fw, f); err != nil {
		return Result{}, err
	}
	if err := mw.Close(); err != nil {
		return Result{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, t.timeout(DefaultSenseVoiceTimeout))
	defer cancel()
	url := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/ai/run/@cf/openai/whisper-large-v3-turbo", t.CFAccountID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &body)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Authorization", "Bearer "+t.CFToken)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	client := t.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return Result{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("status %d: %s", resp.StatusCode, truncate(string(data), 300))
	}
	var parsed struct {
		Success bool `json:"success"`
		Result  struct {
			Text string `json:"text"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return Result{}, fmt.Errorf("bad response: %w", err)
	}
	if !parsed.Success {
		return Result{}, errors.New("api error: " + truncate(string(data), 300))
	}
	return Result{Text: strings.TrimSpace(parsed.Result.Text), Engine: EngineCFWhisper}, nil
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
