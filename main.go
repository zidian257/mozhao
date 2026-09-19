// 默照 · Go 单二进制后端。
// 配置全部走 OBS_* 环境变量（契约 §鉴权与配置）。
package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"mozhao/internal/server"
	"mozhao/internal/store"
	"mozhao/internal/stt"
)

//go:embed all:web/dist
var webDist embed.FS

type config struct {
	Port            string
	DataDir         string
	Tokens          []string
	SealWindow      time.Duration
	SealWindowLabel string
	STTEngine       string
	WhisperBin      string
	WhisperModel    string
	SenseVoiceBin   string
	SenseVoiceModel string
	Hotwords        string
	CFAccountID     string
	CFToken         string
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	var cfg config
	cfg.Port = envOr("OBS_PORT", "8787")
	cfg.DataDir = envOr("OBS_DATA_DIR", "./data")
	for _, t := range strings.Split(os.Getenv("OBS_TOKENS"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			cfg.Tokens = append(cfg.Tokens, t)
		}
	}
	label := envOr("OBS_SEAL_WINDOW", "240h")
	d, err := time.ParseDuration(label)
	if err != nil {
		log.Fatalf("invalid OBS_SEAL_WINDOW %q: %v", label, err)
	}
	cfg.SealWindow, cfg.SealWindowLabel = d, label
	cfg.STTEngine = envOr("OBS_STT_ENGINE", stt.EngineWhisper)
	switch cfg.STTEngine {
	case stt.EngineCF, stt.EngineWhisper, stt.EngineSenseVoice:
	default:
		log.Fatalf("invalid OBS_STT_ENGINE %q: want %q, %q or %q", cfg.STTEngine, stt.EngineCF, stt.EngineWhisper, stt.EngineSenseVoice)
	}
	cfg.WhisperBin = envOr("OBS_WHISPER_BIN", "./vendor/whisper/whisper.cpp/build/bin/whisper-cli")
	cfg.WhisperModel = envOr("OBS_WHISPER_MODEL", "./vendor/whisper/models/ggml-large-v3-turbo.bin")
	cfg.SenseVoiceBin = envOr("OBS_SENSEVOICE_BIN", "./vendor/sensevoice/SenseVoice.cpp/build/bin/sense-voice-main")
	cfg.SenseVoiceModel = envOr("OBS_SENSEVOICE_MODEL", "./vendor/sensevoice/models/sense-voice-small-fp16.gguf")
	cfg.Hotwords = os.Getenv("OBS_HOTWORDS")
	cfg.CFAccountID = os.Getenv("OBS_CF_ACCOUNT_ID")
	cfg.CFToken = os.Getenv("OBS_CF_API_TOKEN")
	return cfg
}

func main() {
	cfg := loadConfig()
	if len(cfg.Tokens) == 0 {
		log.Printf("警告: OBS_TOKENS 为空，开发模式启用——所有 API 请求放行，仅限 localhost 使用")
	}
	if cfg.CFAccountID == "" || cfg.CFToken == "" {
		log.Printf("OBS_CF_ACCOUNT_ID/OBS_CF_API_TOKEN 未配置：云端转写兜底禁用")
	}

	st, err := store.Open(cfg.DataDir, cfg.SealWindow)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	tr := &stt.Transcriber{
		Engine:          cfg.STTEngine,
		WhisperBin:      cfg.WhisperBin,
		WhisperModel:    cfg.WhisperModel,
		SenseVoiceBin:   cfg.SenseVoiceBin,
		SenseVoiceModel: cfg.SenseVoiceModel,
		Hotwords:        cfg.Hotwords,
		CFAccountID:     cfg.CFAccountID,
		CFToken:         cfg.CFToken,
	}
	if msg, ok := tr.Ready(); ok {
		log.Printf("%s", msg)
	} else {
		log.Printf("警告: %s——本地转写将失败，走云端兜底或记 failed（不退出）", msg)
	}
	static, err := fs.Sub(webDist, "web/dist")
	if err != nil {
		log.Fatalf("embed static: %v", err)
	}
	srv := server.New(st, tr, server.Config{
		Tokens:          cfg.Tokens,
		SealWindowLabel: cfg.SealWindowLabel,
		Static:          static,
	})
	srv.RecoverPending()

	httpSrv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Printf("mozhao listening on :%s (data=%s seal_window=%s)", cfg.Port, cfg.DataDir, cfg.SealWindowLabel)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()
	<-ctx.Done()
	log.Printf("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	httpSrv.Shutdown(sctx) //nolint:errcheck
}
