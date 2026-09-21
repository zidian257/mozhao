// Package server 实现契约全部 HTTP 端点：chi 路由、Bearer 中间件、
// 异步转写调度、embed 前端静态资源、export zip 流式打包。
package server

import (
	"archive/zip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"mozhao/internal/store"
	"mozhao/internal/stt"
	"mozhao/internal/ulid"
)

// Config 是服务层配置。Tokens 为空 = 开发模式全放行。
type Config struct {
	Tokens          []string
	SealWindowLabel string // 原样回显 OBS_SEAL_WINDOW（如 "240h"）
	Static          fs.FS  // embed 的前端 dist
}

// Server 组合 store 与 stt，暴露 http.Handler。
type Server struct {
	store *store.Store
	stt   *stt.Transcriber
	cfg   Config
	mux   *chi.Mux
	sem   chan struct{} // 转写并发上限 1：串行队列，n=1 足够
}

// New 装配路由。
func New(st *store.Store, tr *stt.Transcriber, cfg Config) *Server {
	s := &Server{store: st, stt: tr, cfg: cfg, mux: chi.NewMux(), sem: make(chan struct{}, 1)}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	r := s.mux
	r.Route("/api", func(r chi.Router) {
		r.Use(logMiddleware) // 在鉴权之前：401 也要留痕
		r.Use(bearerMiddleware(s.cfg.Tokens))
		r.Post("/capture", s.handleCapture)
		r.Get("/entries", s.handleListEntries)
		r.Get("/entries/{id}", s.handleGetEntry)
		r.Get("/entries/{id}/transcript", s.handleGetTranscript)
		r.Patch("/entries/{id}", s.handlePatchEntry)
		r.Delete("/entries/{id}", s.handleDeleteEntry)
		r.Get("/search", s.handleSearch)
		r.Get("/status", s.handleStatus)
		r.Get("/entries/{id}/media", s.handleMedia)
		r.Get("/export", s.handleExport)
	})
	if s.cfg.Static != nil {
		r.Get("/*", staticHandler(s.cfg.Static).ServeHTTP)
	}
}

// 请求日志：/api 每请求一行（方法 路径 状态 耗时）——公网隧道场景的唯一排障视野。
// 转写轮询的 200 是高频噪音（校对页每 2.5s 一次），不记；其 404/失败照记。
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if r.Method == http.MethodGet && sw.status == http.StatusOK &&
			strings.HasSuffix(r.URL.Path, "/transcript") {
			return
		}
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status,
			time.Since(start).Round(time.Millisecond))
	})
}

// bearerMiddleware 校验 Authorization: Bearer <token> ∈ OBS_TOKENS；
// tokens 为空时全放行（开发模式，启动日志另有警告）。
func bearerMiddleware(tokens []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if len(tokens) == 0 {
				next.ServeHTTP(w, r)
				return
			}
			if tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
				for _, t := range tokens {
					if subtle.ConstantTimeCompare([]byte(tok), []byte(t)) == 1 {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
			writeError(w, http.StatusUnauthorized, "unauthorized")
		})
	}
}

// ---------- capture ----------

const maxAudioBytes = 200 << 20

// captureExtByMIME 按契约「扩展名按 Content-Type 定（m4a/mp4/webm/ogg/wav）」。
var captureExtByMIME = map[string]string{
	"audio/mp4":       ".m4a",
	"audio/x-m4a":     ".m4a",
	"audio/m4a":       ".m4a",
	"video/mp4":       ".mp4",
	"audio/webm":      ".webm",
	"video/webm":      ".webm",
	"audio/ogg":       ".ogg",
	"application/ogg": ".ogg",
	"audio/wav":       ".wav",
	"audio/x-wav":     ".wav",
	"audio/wave":      ".wav",
}

var mediaMIMEByExt = map[string]string{
	".m4a":  "audio/mp4",
	".mp4":  "video/mp4",
	".webm": "audio/webm",
	".ogg":  "audio/ogg",
	".wav":  "audio/wav",
}

func (s *Server) handleCapture(w http.ResponseWriter, r *http.Request) {
	ct := r.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(ct, "multipart/form-data"):
		s.captureAudio(w, r)
	case strings.HasPrefix(ct, "application/json"):
		s.captureText(w, r)
	default:
		writeError(w, http.StatusBadRequest, "unsupported content type")
	}
}

// captureText 处理 JSON {"id","text","src"}。
func (s *Server) captureText(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Text string `json:"text"`
		Src  string `json:"src"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if !ulid.Valid(req.ID) {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeError(w, http.StatusBadRequest, "text required")
		return
	}
	dedup, err := s.store.AddEntry(store.Event{
		ID: req.ID, Ts: s.store.NowTime(), Type: store.TypeText,
		Body: req.Text, Src: req.Src,
	})
	if err != nil {
		log.Printf("capture text %s: %v", req.ID, err)
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": req.ID, "dedup": dedup})
}

// captureAudio 处理 multipart：audio 文件 + 字段 id,dur,src。
func (s *Server) captureAudio(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAudioBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart")
		return
	}
	id := r.FormValue("id")
	if !ulid.Valid(id) {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var dur *float64
	if ds := r.FormValue("dur"); ds != "" {
		d, err := strconv.ParseFloat(ds, 64)
		if err != nil || d < 0 {
			writeError(w, http.StatusBadRequest, "invalid dur")
			return
		}
		dur = &d
	}
	src := r.FormValue("src")
	file, header, err := r.FormFile("audio")
	if err != nil {
		writeError(w, http.StatusBadRequest, "audio file required")
		return
	}
	defer file.Close()

	ext, err := detectExt(header.Header.Get("Content-Type"), file)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.store.Has(id) {
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "dedup": true})
		return
	}
	ts := s.store.NowTime()
	rel, err := s.store.SaveAttachment(id, ts, ext, file)
	if err != nil {
		log.Printf("save attachment %s: %v", id, err)
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	dedup, err := s.store.AddEntry(store.Event{
		ID: id, Ts: ts, Type: store.TypeVoice, Media: rel, Dur: dur, Src: src,
	})
	if err != nil {
		log.Printf("capture voice %s: %v", id, err)
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	if !dedup {
		s.enqueueTranscription(id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "dedup": dedup})
}

// detectExt 先按 Content-Type 定扩展名；octet-stream/未知类型时嗅探魔数。
func detectExt(ct string, file multipart.File) (string, error) {
	ct = strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))
	if ext, ok := captureExtByMIME[ct]; ok {
		return ext, nil
	}
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", fmt.Errorf("cannot read audio")
	}
	return sniffExt(buf[:n])
}

func sniffExt(b []byte) (string, error) {
	switch {
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WAVE":
		return ".wav", nil
	case len(b) >= 4 && string(b[:4]) == "OggS":
		return ".ogg", nil
	case len(b) >= 4 && b[0] == 0x1A && b[1] == 0x45 && b[2] == 0xDF && b[3] == 0xA3:
		return ".webm", nil
	case len(b) >= 8 && string(b[4:8]) == "ftyp":
		return ".m4a", nil
	}
	return "", fmt.Errorf("unsupported audio type")
}

// ---------- 转写调度 ----------

// enqueueTranscription 后台 goroutine 转写；串行（sem 容量 1）。
func (s *Server) enqueueTranscription(id string) {
	go func() {
		s.sem <- struct{}{}
		defer func() { <-s.sem }()
		e, ok := s.store.Entry(id)
		if !ok || e.Media == "" {
			return
		}
		s.transcribe(id, s.store.AbsMedia(e.Media))
	}()
}

// transcribe 跑引擎链；完成/失败都追加 transcript 事件。
func (s *Server) transcribe(id, audioPath string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	res, err := s.stt.Transcribe(ctx, audioPath)
	ev := store.Event{Type: store.TypeTranscript, Ref: id, Ts: s.store.NowTime()}
	if err != nil {
		log.Printf("transcribe %s: %v", id, err)
		ev.Engine = store.EngineFailed
	} else {
		ev.Engine = res.Engine
		ev.Text = res.Text
		for _, seg := range res.Segments {
			ev.Segments = append(ev.Segments, store.Segment{T: seg.T, D: seg.D, Text: seg.Text})
		}
	}
	if err := s.store.AppendEvent(ev); err != nil {
		log.Printf("append transcript %s: %v", id, err)
	}
}

// RecoverPending 重启后补转写：为没有 transcript 事件的 voice 条目重新入队。
func (s *Server) RecoverPending() {
	for _, id := range s.store.PendingTranscription() {
		log.Printf("re-enqueue pending transcription %s", id)
		s.enqueueTranscription(id)
	}
}

// ---------- entries ----------

// entryJSON 契约形状：{"id","ts","type","media","dur","text","src"}。
type entryJSON struct {
	ID    string    `json:"id"`
	Ts    time.Time `json:"ts"`
	Type  string    `json:"type"`
	Media *string   `json:"media"`
	Dur   *float64  `json:"dur"`
	Text  *string   `json:"text"`
	Src   string    `json:"src"`
}

func toEntryJSON(e *store.Entry) entryJSON {
	var media *string
	if e.Type == store.TypeVoice && e.Media != "" {
		u := "/api/entries/" + e.ID + "/media"
		media = &u
	}
	return entryJSON{
		ID: e.ID, Ts: e.Ts, Type: e.Type,
		Media: media, Dur: e.Dur, Text: e.FoldedText(), Src: e.Src,
	}
}

func entryList(es []*store.Entry) []entryJSON {
	out := make([]entryJSON, 0, len(es))
	for _, e := range es {
		out = append(out, toEntryJSON(e))
	}
	return out
}

func (s *Server) handleListEntries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 30
	if ls := q.Get("limit"); ls != "" {
		n, err := strconv.Atoi(ls)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = n
	}
	entries, next, err := s.store.List(q.Get("cursor"), limit)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entryList(entries), "next_cursor": next})
}

func (s *Server) handleGetEntry(w http.ResponseWriter, r *http.Request) {
	e, ok := s.store.UnlockedEntry(chi.URLParam(r, "id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, toEntryJSON(e))
}

// handleGetTranscript：校对窗口内或已解锁可见；文本条目无 transcript → 404。
func (s *Server) handleGetTranscript(w http.ResponseWriter, r *http.Request) {
	e, ok := s.store.ProofreadEntry(chi.URLParam(r, "id"))
	if !ok || e.Type != store.TypeVoice {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	status, text := e.TranscriptStatus()
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "text": text})
}

// handlePatchEntry 追加 edit 事件；校对窗口内或已解锁。
func (s *Server) handlePatchEntry(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, ok := s.store.ProofreadEntry(id); !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := s.store.AppendEvent(store.Event{
		Type: store.TypeEdit, Ref: id, Ts: s.store.NowTime(), Body: req.Body,
	}); err != nil {
		log.Printf("edit %s: %v", id, err)
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteEntry 追加 delete tombstone；校对窗口内（校对页「丢弃」）或已解锁。附件保留。
func (s *Server) handleDeleteEntry(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, ok := s.store.ProofreadEntry(id); !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := s.store.AppendEvent(store.Event{
		Type: store.TypeDelete, Ref: id, Ts: s.store.NowTime(),
	}); err != nil {
		log.Printf("delete %s: %v", id, err)
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	entries := s.store.Search(r.URL.Query().Get("q"))
	writeJSON(w, http.StatusOK, map[string]any{"entries": entryList(entries)})
}

// handleStatus 只暴露计数，无任何内容信息。
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	sealed, unlocked := s.store.Counts()
	writeJSON(w, http.StatusOK, map[string]any{
		"sealed_count":   sealed,
		"unlocked_count": unlocked,
		"has_unlocked":   unlocked > 0,
		"seal_window":    s.cfg.SealWindowLabel,
	})
}

// handleMedia 音频流（含 Range 支持）；仅已解锁。
func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	e, ok := s.store.UnlockedEntry(chi.URLParam(r, "id"))
	if !ok || e.Media == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	path := s.store.AbsMedia(e.Media)
	f, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ct := mediaMIMEByExt[strings.ToLower(filepath.Ext(path))]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// handleExport 流式打包整个 data 目录（jsonl + attachments）。
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="mozhao-export-%s.zip"`, time.Now().Format("20060102-150405")))
	zw := zip.NewWriter(w)
	root := s.store.DataDir()
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".tmp-") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		hdr.Method = zip.Deflate
		fw, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		_, cerr := io.Copy(fw, f)
		f.Close() //nolint:errcheck
		return cerr
	})
	if err != nil {
		log.Printf("export: %v", err)
	}
	if err := zw.Close(); err != nil {
		log.Printf("export close: %v", err)
	}
}

// ---------- 静态资源 ----------

// staticHandler 服务 embed 的前端 dist；未知路径回退 index.html（SPA）。
// 静态资源不鉴权（契约：PWA 壳由更外层的 Access 拦）。
// 支持构建期预压缩的 .br/.gz 旁挂文件；带 hash 的 /assets/* 长缓存，
// index.html / manifest / sw.js 不缓存。
func staticHandler(fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(fsys, p); err != nil {
			p = "index.html"
		}

		w.Header().Set("Vary", "Accept-Encoding")
		switch {
		case strings.HasPrefix(p, "assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case strings.HasPrefix(p, "icons/"):
			w.Header().Set("Cache-Control", "public, max-age=604800")
		default:
			w.Header().Set("Cache-Control", "no-cache")
		}

		name := path.Base(p)
		if strings.HasSuffix(name, ".webmanifest") {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		accept := r.Header.Get("Accept-Encoding")
		for _, enc := range [][2]string{{"br", ".br"}, {"gzip", ".gz"}} {
			if !strings.Contains(accept, enc[0]) {
				continue
			}
			if f, err := fsys.Open(p + enc[1]); err == nil {
				defer f.Close() //nolint:errcheck
				st, err := f.Stat()
				if err != nil {
					break
				}
				rs, ok := f.(io.ReadSeeker)
				if !ok {
					break
				}
				w.Header().Set("Content-Encoding", enc[0])
				http.ServeContent(w, r, name, st.ModTime(), rs)
				return
			}
		}

		f, err := fsys.Open(p)
		if err != nil {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		defer f.Close() //nolint:errcheck
		st, err := f.Stat()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "stat error")
			return
		}
		rs, ok := f.(io.ReadSeeker)
		if !ok {
			writeError(w, http.StatusInternalServerError, "seek error")
			return
		}
		http.ServeContent(w, r, name, st.ModTime(), rs)
	})
}

// ---------- helpers ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}
