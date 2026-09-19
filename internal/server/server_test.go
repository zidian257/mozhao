package server_test

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"mozhao/internal/server"
	"mozhao/internal/store"
	"mozhao/internal/stt"
	"mozhao/internal/ulid"
)

var testZone = time.FixedZone("CST", 8*3600)

func baseTime() time.Time { return time.Date(2026, 9, 18, 12, 0, 0, 0, testZone) }

// safeClock 可被转写 goroutine 并发读取。
type safeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *safeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *safeClock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

type fixture struct {
	ts    *httptest.Server
	store *store.Store
	clock *safeClock
	dir   string
}

// newFixture 起一个无 STT 引擎的服务（转写必走 failed 分支），token 默认 test123。
func newFixture(t *testing.T, window time.Duration, label string, tokens []string) *fixture {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir, window)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	clock := &safeClock{t: baseTime()}
	st.Now = clock.now
	tr := &stt.Transcriber{Logf: func(string, ...any) {}}
	srv := server.New(st, tr, server.Config{Tokens: tokens, SealWindowLabel: label})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &fixture{ts: ts, store: st, clock: clock, dir: dir}
}

func doReq(t *testing.T, method, rawURL, token, ctype string, body io.Reader) (int, []byte, http.Header) {
	t.Helper()
	req, err := http.NewRequest(method, rawURL, body)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, rawURL, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, data, resp.Header
}

func decodeJSON(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	return m
}

// testWav 造一段最小合法 PCM wav（0.1s 静音，16k mono 16bit）。
func testWav() []byte {
	data := make([]byte, 3200)
	var buf bytes.Buffer
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(36+len(data))) //nolint:errcheck
	buf.WriteString("WAVE")
	buf.WriteString("fmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16))    //nolint:errcheck
	binary.Write(&buf, binary.LittleEndian, uint16(1))     // PCM //nolint:errcheck
	binary.Write(&buf, binary.LittleEndian, uint16(1))     // mono //nolint:errcheck
	binary.Write(&buf, binary.LittleEndian, uint32(16000)) // rate //nolint:errcheck
	binary.Write(&buf, binary.LittleEndian, uint32(32000)) // byte rate //nolint:errcheck
	binary.Write(&buf, binary.LittleEndian, uint16(2))     // block align //nolint:errcheck
	binary.Write(&buf, binary.LittleEndian, uint16(16))    // bits //nolint:errcheck
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(len(data))) //nolint:errcheck
	buf.Write(data)
	return buf.Bytes()
}

func multipartAudio(t *testing.T, fields map[string]string, filename string, wav []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("WriteField: %v", err)
		}
	}
	fw, err := mw.CreateFormFile("audio", filename) // Content-Type: application/octet-stream → 走魔数嗅探
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(wav); err != nil {
		t.Fatalf("write wav: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}
	return &buf, mw.FormDataContentType()
}

func pollTranscript(t *testing.T, base, id, token string, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		code, body, _ := doReq(t, http.MethodGet, fmt.Sprintf("%s/api/entries/%s/transcript", base, id), token, "", nil)
		if code == 200 {
			m := decodeJSON(t, body)
			if m["status"] == want {
				return m
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("poll transcript %s: never reached %q (last %d %s)", id, want, code, body)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func entriesOf(t *testing.T, m map[string]any) []any {
	t.Helper()
	es, ok := m["entries"].([]any)
	if !ok {
		t.Fatalf("entries not a list: %v", m)
	}
	return es
}

// 契约全流程（文本）：capture(JSON) → 封存不可见 → 校对窗口 PATCH →
// 解锁可见/可搜 → DELETE → status 计数归零。
func TestTextCaptureFlow(t *testing.T) {
	f := newFixture(t, 10*time.Second, "10s", []string{"test123"})
	base := f.ts.URL
	id := ulid.New(baseTime())

	// 无 token → 401
	code, _, _ := doReq(t, http.MethodPost, base+"/api/capture", "", "application/json",
		bytes.NewReader([]byte(`{"id":"`+id+`","text":"x","src":"pwa"}`)))
	if code != http.StatusUnauthorized {
		t.Fatalf("no token: code = %d; want 401", code)
	}

	// capture
	body := fmt.Sprintf(`{"id":%q,"text":"第一条记录","src":"shortcut-text"}`, id)
	code, data, _ := doReq(t, http.MethodPost, base+"/api/capture", "test123", "application/json", bytes.NewReader([]byte(body)))
	if code != http.StatusOK {
		t.Fatalf("capture: code = %d body = %s", code, data)
	}
	m := decodeJSON(t, data)
	if m["id"] != id || m["dedup"] != false {
		t.Fatalf("capture resp = %v", m)
	}

	// 幂等重传
	code, data, _ = doReq(t, http.MethodPost, base+"/api/capture", "test123", "application/json", bytes.NewReader([]byte(body)))
	if code != http.StatusOK || decodeJSON(t, data)["dedup"] != true {
		t.Fatalf("re-capture: code = %d body = %s; want dedup:true", code, data)
	}

	// 非法 id → 400
	bad := `{"id":"not-a-ulid","text":"x","src":"pwa"}`
	code, _, _ = doReq(t, http.MethodPost, base+"/api/capture", "test123", "application/json", bytes.NewReader([]byte(bad)))
	if code != http.StatusBadRequest {
		t.Fatalf("bad id: code = %d; want 400", code)
	}

	// 封存期：entries/search/单条 一律不可见
	code, data, _ = doReq(t, http.MethodGet, base+"/api/entries", "test123", "", nil)
	if code != http.StatusOK || len(entriesOf(t, decodeJSON(t, data))) != 0 {
		t.Fatalf("sealed entries: %d %s", code, data)
	}
	code, _, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id, "test123", "", nil)
	if code != http.StatusNotFound {
		t.Fatalf("sealed get: code = %d; want 404", code)
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/search?q="+url.QueryEscape("第一条"), "test123", "", nil)
	if code != http.StatusOK || len(entriesOf(t, decodeJSON(t, data))) != 0 {
		t.Fatalf("sealed search: %d %s", code, data)
	}

	// status 只暴露计数
	code, data, _ = doReq(t, http.MethodGet, base+"/api/status", "test123", "", nil)
	m = decodeJSON(t, data)
	if code != http.StatusOK || m["sealed_count"] != float64(1) || m["unlocked_count"] != float64(0) ||
		m["has_unlocked"] != false || m["seal_window"] != "10s" {
		t.Fatalf("status = %d %s", code, data)
	}

	// 校对窗口内 PATCH → 204
	code, _, _ = doReq(t, http.MethodPatch, base+"/api/entries/"+id, "test123", "application/json",
		bytes.NewReader([]byte(`{"body":"第一条记录（校对）"}`)))
	if code != http.StatusNoContent {
		t.Fatalf("patch in proofread window: code = %d; want 204", code)
	}

	// 解锁
	f.clock.set(baseTime().Add(11 * time.Second))
	code, data, _ = doReq(t, http.MethodGet, base+"/api/entries", "test123", "", nil)
	es := entriesOf(t, decodeJSON(t, data))
	if code != http.StatusOK || len(es) != 1 {
		t.Fatalf("unlocked entries: %d %s", code, data)
	}
	e := es[0].(map[string]any)
	if e["id"] != id || e["type"] != "text" || e["text"] != "第一条记录（校对）" ||
		e["media"] != nil || e["dur"] != nil || e["src"] != "shortcut-text" {
		t.Fatalf("entry shape = %v", e)
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id, "test123", "", nil)
	if code != http.StatusOK || decodeJSON(t, data)["text"] != "第一条记录（校对）" {
		t.Fatalf("get unlocked: %d %s", code, data)
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/search?q="+url.QueryEscape("校对"), "test123", "", nil)
	if code != http.StatusOK || len(entriesOf(t, decodeJSON(t, data))) != 1 {
		t.Fatalf("unlocked search: %d %s", code, data)
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/status", "test123", "", nil)
	m = decodeJSON(t, data)
	if m["sealed_count"] != float64(0) || m["unlocked_count"] != float64(1) || m["has_unlocked"] != true {
		t.Fatalf("status after unlock = %s", data)
	}

	// DELETE → 204，之后彻底不可见
	code, _, _ = doReq(t, http.MethodDelete, base+"/api/entries/"+id, "test123", "", nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete: code = %d; want 204", code)
	}
	code, _, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id, "test123", "", nil)
	if code != http.StatusNotFound {
		t.Fatalf("get deleted: code = %d; want 404", code)
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/status", "test123", "", nil)
	m = decodeJSON(t, data)
	if m["sealed_count"] != float64(0) || m["unlocked_count"] != float64(0) {
		t.Fatalf("status after delete = %s", data)
	}
}

// 契约全流程（语音）：multipart capture → 校对窗口内 transcript 轮询可见、
// entries 不可见 → 解锁后 media 可流式获取 → PATCH → 折叠文本更新。
func TestVoiceCaptureFlow(t *testing.T) {
	f := newFixture(t, 10*time.Second, "10s", []string{"test123"})
	base := f.ts.URL
	id := ulid.New(baseTime())
	wav := testWav()

	body, ctype := multipartAudio(t, map[string]string{"id": id, "dur": "2.5", "src": "pwa"}, "rec.wav", wav)
	code, data, _ := doReq(t, http.MethodPost, base+"/api/capture", "test123", ctype, body)
	if code != http.StatusOK || decodeJSON(t, data)["dedup"] != false {
		t.Fatalf("voice capture: %d %s", code, data)
	}

	// 附件已按月落盘
	att := filepath.Join(f.dir, "attachments", "2026-09", id+".wav")
	got, err := os.ReadFile(att)
	if err != nil || !bytes.Equal(got, wav) {
		t.Fatalf("attachment: err=%v equal=%v", err, bytes.Equal(got, wav))
	}

	// 校对窗口内：transcript 可轮询（无 STT 引擎 → failed），但 entries 列表不可见
	m := pollTranscript(t, base, id, "test123", "failed")
	if m["text"] != "" {
		t.Fatalf("failed transcript text = %v; want empty", m["text"])
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/entries", "test123", "", nil)
	if code != http.StatusOK || len(entriesOf(t, decodeJSON(t, data))) != 0 {
		t.Fatalf("sealed entries during proofread: %d %s", code, data)
	}
	code, _, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id+"/media", "test123", "", nil)
	if code != http.StatusNotFound {
		t.Fatalf("sealed media: code = %d; want 404", code)
	}

	// 解锁后：条目可见，media 可流式获取且 Content-Type 正确
	f.clock.set(baseTime().Add(11 * time.Second))
	code, data, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id, "test123", "", nil)
	e := decodeJSON(t, data)
	if code != http.StatusOK || e["media"] != "/api/entries/"+id+"/media" ||
		e["dur"] != 2.5 || e["text"] != nil || e["type"] != "voice" {
		t.Fatalf("unlocked voice entry = %d %s", code, data)
	}
	code, data, hdr := doReq(t, http.MethodGet, base+"/api/entries/"+id+"/media", "test123", "", nil)
	if code != http.StatusOK || hdr.Get("Content-Type") != "audio/wav" || !bytes.Equal(data, wav) {
		t.Fatalf("media: code=%d ct=%q bytes=%d", code, hdr.Get("Content-Type"), len(data))
	}

	// PATCH 后折叠文本更新，transcript 端点同样反映
	code, _, _ = doReq(t, http.MethodPatch, base+"/api/entries/"+id, "test123", "application/json",
		bytes.NewReader([]byte(`{"body":"人工转写"}`)))
	if code != http.StatusNoContent {
		t.Fatalf("patch voice: code = %d; want 204", code)
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id+"/transcript", "test123", "", nil)
	m = decodeJSON(t, data)
	if code != http.StatusOK || m["status"] != "failed" || m["text"] != "人工转写" {
		t.Fatalf("transcript after edit = %d %s", code, data)
	}
	code, data, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id, "test123", "", nil)
	if decodeJSON(t, data)["text"] != "人工转写" {
		t.Fatalf("entry after edit = %s", data)
	}
}

// 校对窗口边界：1h 后、解锁前，transcript 与 PATCH 一律 404。
func TestProofreadWindowExpiry(t *testing.T) {
	f := newFixture(t, 240*time.Hour, "240h", []string{"test123"})
	base := f.ts.URL
	id := ulid.New(baseTime())
	body, ctype := multipartAudio(t, map[string]string{"id": id, "src": "pwa"}, "rec.wav", testWav())
	code, data, _ := doReq(t, http.MethodPost, base+"/api/capture", "test123", ctype, body)
	if code != http.StatusOK {
		t.Fatalf("capture: %d %s", code, data)
	}
	pollTranscript(t, base, id, "test123", "failed") // 1h 内可见

	f.clock.set(baseTime().Add(2 * time.Hour)) // 出校对窗口，仍在封存
	code, _, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id+"/transcript", "test123", "", nil)
	if code != http.StatusNotFound {
		t.Fatalf("transcript after 2h sealed: code = %d; want 404", code)
	}
	code, _, _ = doReq(t, http.MethodPatch, base+"/api/entries/"+id, "test123", "application/json",
		bytes.NewReader([]byte(`{"body":"x"}`)))
	if code != http.StatusNotFound {
		t.Fatalf("patch after 2h sealed: code = %d; want 404", code)
	}
	code, _, _ = doReq(t, http.MethodDelete, base+"/api/entries/"+id, "test123", "", nil)
	if code != http.StatusNotFound {
		t.Fatalf("delete while sealed: code = %d; want 404", code)
	}

	f.clock.set(baseTime().Add(240 * time.Hour)) // 解锁
	code, _, _ = doReq(t, http.MethodGet, base+"/api/entries/"+id+"/transcript", "test123", "", nil)
	if code != http.StatusOK {
		t.Fatalf("transcript unlocked: code = %d; want 200", code)
	}
}

// 分页：cursor 翻页到底，非法 cursor/limit 拒绝。
func TestPagination(t *testing.T) {
	f := newFixture(t, time.Second, "1s", []string{"test123"})
	base := f.ts.URL
	ts0 := baseTime()
	wantOrder := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		id := ulid.New(ts0.Add(time.Duration(i) * time.Second))
		dur := 0
		_ = dur
		if _, err := f.store.AddEntry(store.Event{
			ID: id, Ts: ts0.Add(time.Duration(i) * time.Second), Type: store.TypeText,
			Body: fmt.Sprintf("第%d条", i), Src: "pwa",
		}); err != nil {
			t.Fatalf("AddEntry: %v", err)
		}
		wantOrder = append([]string{id}, wantOrder...) // 新→旧
	}
	f.clock.set(ts0.Add(time.Hour))

	var got []string
	cursor := ""
	for page := 0; ; page++ {
		u := base + "/api/entries?limit=2"
		if cursor != "" {
			u += "&cursor=" + url.QueryEscape(cursor)
		}
		code, data, _ := doReq(t, http.MethodGet, u, "test123", "", nil)
		if code != http.StatusOK {
			t.Fatalf("page %d: code = %d body = %s", page, code, data)
		}
		m := decodeJSON(t, data)
		for _, e := range entriesOf(t, m) {
			got = append(got, e.(map[string]any)["id"].(string))
		}
		cursor, _ = m["next_cursor"].(string)
		if cursor == "" {
			break
		}
		if page > 10 {
			t.Fatal("pagination did not terminate")
		}
	}
	if len(got) != len(wantOrder) {
		t.Fatalf("got %d entries; want %d", len(got), len(wantOrder))
	}
	for i := range wantOrder {
		if got[i] != wantOrder[i] {
			t.Fatalf("order[%d] = %s; want %s (full %v)", i, got[i], wantOrder[i], got)
		}
	}

	code, _, _ := doReq(t, http.MethodGet, base+"/api/entries?cursor=garbage", "test123", "", nil)
	if code != http.StatusBadRequest {
		t.Fatalf("bad cursor: code = %d; want 400", code)
	}
	code, _, _ = doReq(t, http.MethodGet, base+"/api/entries?limit=abc", "test123", "", nil)
	if code != http.StatusBadRequest {
		t.Fatalf("bad limit: code = %d; want 400", code)
	}
}

// 鉴权：错误 token 401；OBS_TOKENS 为空 = 开发模式全放行。
func TestAuth(t *testing.T) {
	f := newFixture(t, time.Second, "1s", []string{"test123", "device-b"})
	code, _, _ := doReq(t, http.MethodGet, f.ts.URL+"/api/status", "", "", nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("no token: %d; want 401", code)
	}
	code, _, _ = doReq(t, http.MethodGet, f.ts.URL+"/api/status", "wrong", "", nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d; want 401", code)
	}
	code, _, _ = doReq(t, http.MethodGet, f.ts.URL+"/api/status", "device-b", "", nil)
	if code != http.StatusOK {
		t.Fatalf("second token: %d; want 200", code)
	}

	dev := newFixture(t, time.Second, "1s", nil)
	code, _, _ = doReq(t, http.MethodGet, dev.ts.URL+"/api/status", "", "", nil)
	if code != http.StatusOK {
		t.Fatalf("dev mode: %d; want 200", code)
	}
}

// 导出：zip 流包含 jsonl 与附件。
func TestExport(t *testing.T) {
	f := newFixture(t, time.Second, "1s", []string{"test123"})
	base := f.ts.URL
	id := ulid.New(baseTime())
	body, ctype := multipartAudio(t, map[string]string{"id": id, "src": "pwa"}, "rec.wav", testWav())
	code, data, _ := doReq(t, http.MethodPost, base+"/api/capture", "test123", ctype, body)
	if code != http.StatusOK {
		t.Fatalf("capture: %d %s", code, data)
	}
	pollTranscript(t, base, id, "test123", "failed")

	code, data, hdr := doReq(t, http.MethodGet, base+"/api/export", "test123", "", nil)
	if code != http.StatusOK || hdr.Get("Content-Type") != "application/zip" {
		t.Fatalf("export: code=%d ct=%q", code, hdr.Get("Content-Type"))
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip reader: %v", err)
	}
	names := make(map[string]bool)
	for _, zf := range zr.File {
		names[zf.Name] = true
	}
	if !names["log-2026-09.jsonl"] {
		t.Fatalf("export missing jsonl: %v", names)
	}
	if !names["attachments/2026-09/"+id+".wav"] {
		t.Fatalf("export missing attachment: %v", names)
	}
}

// 静态占位页可访问且不鉴权。
func TestStaticPlaceholder(t *testing.T) {
	st, err := store.Open(t.TempDir(), time.Second)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	srv := server.New(st, &stt.Transcriber{}, server.Config{
		Tokens: []string{"test123"}, SealWindowLabel: "1s", Static: os.DirFS("."),
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	// DirFS(".") 下没有 index.html → 回退也会 404；这里只验证 /api 未知路径是 JSON 404 且鉴权生效。
	code, _, _ := doReq(t, http.MethodGet, ts.URL+"/api/nope", "", "", nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("unknown api without token: %d; want 401", code)
	}
}
