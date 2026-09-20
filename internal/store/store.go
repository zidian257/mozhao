// Package store 实现契约的 append-only JSONL 存储：
// 按月切分 log-YYYY-MM.jsonl（flock 追加写）、附件落盘 attachments/YYYY-MM/、
// 启动时全量重建内存索引、读侧事件折叠、滚动封存判定与幂等去重。
package store

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// 事件类型（契约 §事件模型）。
const (
	TypeVoice      = "voice"
	TypeText       = "text"
	TypeTranscript = "transcript"
	TypeEdit       = "edit"
	TypeDelete     = "delete"
)

// EngineFailed 标记转写彻底失败后的 transcript 事件。
const EngineFailed = "failed"

// ProofreadWindow 是契约规定的校对窗口：entry 创建后 1 小时内
// 允许 GET transcript 与 PATCH。
const ProofreadWindow = time.Hour

// Segment 是句级转写时间戳（秒）。
type Segment struct {
	T    float64 `json:"t"`
	D    float64 `json:"d"`
	Text string  `json:"text"`
}

// Event 是 JSONL 里的一行。voice/text 事件带 id；transcript/edit/delete 带 ref。
type Event struct {
	ID       string    `json:"id,omitempty"`
	Ts       time.Time `json:"ts"`
	Type     string    `json:"type"`
	Media    string    `json:"media,omitempty"`
	Dur      *float64  `json:"dur,omitempty"`
	Src      string    `json:"src,omitempty"`
	Body     string    `json:"body,omitempty"`
	Ref      string    `json:"ref,omitempty"`
	Text     string    `json:"text,omitempty"`
	Engine   string    `json:"engine,omitempty"`
	Segments []Segment `json:"segments,omitempty"`
}

// Transcript 是一条转写派生数据。
type Transcript struct {
	Ts       time.Time
	Text     string
	Engine   string
	Segments []Segment
}

// Entry 是一个 id 折叠全部事件后的读侧状态。
type Entry struct {
	ID                 string
	Ts                 time.Time
	Type               string // voice | text
	Media              string // 相对 data 目录的路径
	Dur                *float64
	Src                string
	Body               string // type=text 的原始文本
	Transcript         *Transcript
	TranscriptAttempts int // 已追加的 transcript 事件数（限制失败重试用）
	Edit               *string // 最新 edit.body
	Deleted            bool
}

// FoldedText 按契约折叠：最新 edit.body ?? transcript.text ?? text.body ?? nil。
// 转写失败（engine=failed）视同无 transcript。
func (e *Entry) FoldedText() *string {
	if e.Edit != nil {
		return e.Edit
	}
	if e.Transcript != nil && e.Transcript.Engine != EngineFailed {
		return &e.Transcript.Text
	}
	if e.Type == TypeText {
		return &e.Body
	}
	return nil
}

// TranscriptStatus 映射契约的 pending|done|failed；text 取折叠后的展示文本。
func (e *Entry) TranscriptStatus() (status, text string) {
	folded := ""
	if f := e.FoldedText(); f != nil {
		folded = *f
	}
	switch {
	case e.Transcript == nil:
		return "pending", ""
	case e.Transcript.Engine == EngineFailed:
		return "failed", folded
	default:
		return "done", folded
	}
}

// Store 是内存索引 + JSONL 追加写的合体。Now 可注入假时钟（测试用），
// 必须在读写并发开始前设置好。
type Store struct {
	mu         sync.RWMutex
	dir        string
	sealWindow time.Duration
	Now        func() time.Time

	ids     map[string]struct{}
	entries map[string]*Entry
	order   []*Entry // 全部 entry，ts 新→旧（同 ts 按 id 降序）
}

// Open 创建目录结构并全量重建索引。
func Open(dir string, sealWindow time.Duration) (*Store, error) {
	s := &Store{
		dir:        dir,
		sealWindow: sealWindow,
		ids:        make(map[string]struct{}),
		entries:    make(map[string]*Entry),
	}
	if err := os.MkdirAll(filepath.Join(dir, "attachments"), 0o755); err != nil {
		return nil, err
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// NowTime 返回注入时钟或真实时钟。
func (s *Store) NowTime() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Store) DataDir() string            { return s.dir }
func (s *Store) SealWindow() time.Duration  { return s.sealWindow }
func (s *Store) AbsMedia(rel string) string { return filepath.Join(s.dir, filepath.FromSlash(rel)) }

func (s *Store) load() error {
	names, err := filepath.Glob(filepath.Join(s.dir, "log-*.jsonl"))
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		if err := s.loadFile(name); err != nil {
			return err
		}
	}
	sort.Slice(s.order, func(i, j int) bool { return less(s.order[i], s.order[j]) })
	return nil
}

func (s *Store) loadFile(name string) error {
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	line := 0
	for sc.Scan() {
		line++
		data := sc.Bytes()
		if len(bytes.TrimSpace(data)) == 0 {
			continue
		}
		var ev Event
		if err := json.Unmarshal(data, &ev); err != nil {
			log.Printf("store: skip malformed line %s:%d: %v", name, line, err)
			continue
		}
		s.apply(&ev)
	}
	return sc.Err()
}

// apply 只改内存索引，不写盘（重建与追加共用）。
func (s *Store) apply(ev *Event) {
	switch ev.Type {
	case TypeVoice, TypeText:
		if _, dup := s.ids[ev.ID]; dup {
			return
		}
		s.ids[ev.ID] = struct{}{}
		e := &Entry{ID: ev.ID, Ts: ev.Ts, Type: ev.Type, Media: ev.Media, Dur: ev.Dur, Src: ev.Src, Body: ev.Body}
		s.entries[ev.ID] = e
		s.order = append(s.order, e)
	case TypeTranscript:
		if e, ok := s.entries[ev.Ref]; ok {
			e.TranscriptAttempts++
			e.Transcript = &Transcript{Ts: ev.Ts, Text: ev.Text, Engine: ev.Engine, Segments: ev.Segments}
		}
	case TypeEdit:
		if e, ok := s.entries[ev.Ref]; ok {
			body := ev.Body
			e.Edit = &body
		}
	case TypeDelete:
		if e, ok := s.entries[ev.Ref]; ok {
			e.Deleted = true
		}
	}
}

// less 定义新→旧排序。
func less(a, b *Entry) bool {
	if a.Ts.Equal(b.Ts) {
		return a.ID > b.ID
	}
	return a.Ts.After(b.Ts)
}

func (s *Store) insertOrder(e *Entry) {
	i := sort.Search(len(s.order), func(i int) bool { return !less(s.order[i], e) })
	s.order = append(s.order, nil)
	copy(s.order[i+1:], s.order[i:])
	s.order[i] = e
}

// appendLineLocked 以 flock 互斥追加一行（跨进程安全；进程内由 mu 保证）。
func appendLineLocked(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock %s: %w", path, err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN) //nolint:errcheck
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

// writeEventLocked 把事件追加到它 ts 所属的月份文件；调用方必须持有 mu。
func (s *Store) writeEventLocked(ev *Event) error {
	if ev.Ts.IsZero() {
		ev.Ts = s.NowTime()
	}
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, "log-"+ev.Ts.Format("2006-01")+".jsonl")
	return appendLineLocked(path, data)
}

// Has 报告 entry id 是否已存在（含已删除——id 永不复用）。
func (s *Store) Has(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.ids[id]
	return ok
}

// AddEntry 落一条 voice/text 事件。同 id 已存在时返回 dedup=true，不写盘。
func (s *Store) AddEntry(ev Event) (dedup bool, err error) {
	if ev.Type != TypeVoice && ev.Type != TypeText {
		return false, fmt.Errorf("store: AddEntry bad type %q", ev.Type)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.ids[ev.ID]; dup {
		return true, nil
	}
	if err := s.writeEventLocked(&ev); err != nil {
		return false, err
	}
	s.ids[ev.ID] = struct{}{}
	e := &Entry{ID: ev.ID, Ts: ev.Ts, Type: ev.Type, Media: ev.Media, Dur: ev.Dur, Src: ev.Src, Body: ev.Body}
	s.entries[ev.ID] = e
	s.insertOrder(e)
	return false, nil
}

// AppendEvent 落一条 transcript/edit/delete 派生事件并更新折叠状态。
func (s *Store) AppendEvent(ev Event) error {
	switch ev.Type {
	case TypeTranscript, TypeEdit, TypeDelete:
	default:
		return fmt.Errorf("store: AppendEvent bad type %q", ev.Type)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writeEventLocked(&ev); err != nil {
		return err
	}
	s.apply(&ev)
	return nil
}

func (s *Store) unlockedLocked(e *Entry, now time.Time) bool {
	return !e.Deleted && !now.Before(e.Ts.Add(s.sealWindow))
}

func (s *Store) proofreadLocked(e *Entry, now time.Time) bool {
	return !e.Deleted && (s.unlockedLocked(e, now) || now.Sub(e.Ts) < ProofreadWindow)
}

// Entry 返回折叠状态（不做可见性判定）。
func (s *Store) Entry(id string) (*Entry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.entries[id]
	return e, ok
}

// UnlockedEntry 仅当 entry 存在、未删除且已解锁时返回。
func (s *Store) UnlockedEntry(id string) (*Entry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.entries[id]
	if !ok || !s.unlockedLocked(e, s.NowTime()) {
		return nil, false
	}
	return e, true
}

// ProofreadEntry 仅当 entry 存在、未删除，且已解锁或仍处校对窗口时返回。
func (s *Store) ProofreadEntry(id string) (*Entry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.entries[id]
	if !ok || !s.proofreadLocked(e, s.NowTime()) {
		return nil, false
	}
	return e, true
}

// List 返回已解锁条目（新→旧）的 cursor 分页。
// cursor 为上一页最后一条的 "ts|id"；next 为空串表示没有更多。
func (s *Store) List(cursor string, limit int) (entries []*Entry, next string, err error) {
	if limit <= 0 {
		limit = 30
	}
	if limit > 100 {
		limit = 100
	}
	var cts time.Time
	var cid string
	if cursor != "" {
		parts := strings.SplitN(cursor, "|", 2)
		if len(parts) != 2 {
			return nil, "", fmt.Errorf("invalid cursor")
		}
		t, perr := time.Parse(time.RFC3339Nano, parts[0])
		if perr != nil {
			return nil, "", fmt.Errorf("invalid cursor: %v", perr)
		}
		cts, cid = t, parts[1]
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := s.NowTime()
	out := make([]*Entry, 0, limit)
	for _, e := range s.order {
		if cursor != "" && (e.Ts.After(cts) || (e.Ts.Equal(cts) && e.ID >= cid)) {
			continue
		}
		if !s.unlockedLocked(e, now) {
			continue
		}
		if len(out) == limit {
			return out, cursorOf(out[len(out)-1]), nil
		}
		out = append(out, e)
	}
	return out, "", nil
}

func cursorOf(e *Entry) string {
	return e.Ts.Format(time.RFC3339Nano) + "|" + e.ID
}

// Search 对已解锁条目的折叠后文本做（大小写不敏感的）子串匹配。
func (s *Store) Search(q string) []*Entry {
	q = strings.ToLower(strings.TrimSpace(q))
	out := make([]*Entry, 0)
	if q == "" {
		return out
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := s.NowTime()
	for _, e := range s.order {
		if !s.unlockedLocked(e, now) {
			continue
		}
		txt := e.FoldedText()
		if txt == nil {
			continue
		}
		if strings.Contains(strings.ToLower(*txt), q) {
			out = append(out, e)
		}
	}
	return out
}

// Counts 返回（未删除的）封存中与已解锁条目数。
func (s *Store) Counts() (sealed, unlocked int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := s.NowTime()
	for _, e := range s.entries {
		if e.Deleted {
			continue
		}
		if s.unlockedLocked(e, now) {
			unlocked++
		} else {
			sealed++
		}
	}
	return sealed, unlocked
}

// maxTranscriptionAttempts 是同一 entry 转写失败的重试上限：
// 每次重启会为 failed 条目补转写，但永久性坏音频不应每次启动都白跑。
const maxTranscriptionAttempts = 3

// PendingTranscription 返回待补转写的 voice 条目（重启后补转写用）：
// 尚无 transcript 事件的，以及最近转写失败但未超重试上限的。
func (s *Store) PendingTranscription() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0)
	for i := len(s.order) - 1; i >= 0; i-- { // 旧→新，先进先转
		e := s.order[i]
		if e.Type != TypeVoice || e.Deleted || e.Media == "" {
			continue
		}
		if e.Transcript == nil ||
			(e.Transcript.Engine == EngineFailed && e.TranscriptAttempts < maxTranscriptionAttempts) {
			ids = append(ids, e.ID)
		}
	}
	return ids
}

// SaveAttachment 把上传音频写到 attachments/YYYY-MM/<id><ext>（月界按 ts），
// 先写临时文件再 rename，返回相对 data 目录的路径。
func (s *Store) SaveAttachment(id string, ts time.Time, ext string, r io.Reader) (string, error) {
	month := ts.Format("2006-01")
	dir := filepath.Join(s.dir, "attachments", month)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := id + ext
	final := filepath.Join(dir, name)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name()) //nolint:errcheck
	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close() //nolint:errcheck
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close() //nolint:errcheck
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return "", err
	}
	return filepath.ToSlash(filepath.Join("attachments", month, name)), nil
}
