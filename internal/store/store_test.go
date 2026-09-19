package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var testZone = time.FixedZone("CST", 8*3600)

func baseTime() time.Time { return time.Date(2026, 9, 18, 12, 0, 0, 0, testZone) }

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time { return c.t }

func openTest(t *testing.T, window time.Duration) (*Store, *testClock) {
	t.Helper()
	s, err := Open(t.TempDir(), window)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	c := &testClock{t: baseTime()}
	s.Now = c.now
	return s, c
}

func mustAdd(t *testing.T, s *Store, ev Event) {
	t.Helper()
	dedup, err := s.AddEntry(ev)
	if err != nil {
		t.Fatalf("AddEntry: %v", err)
	}
	if dedup {
		t.Fatalf("AddEntry %s: unexpected dedup", ev.ID)
	}
}

func mustAppend(t *testing.T, s *Store, ev Event) {
	t.Helper()
	if err := s.AppendEvent(ev); err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
}

// 滚动封存边界：恰好满窗口解锁；差 1 秒不解锁。
func TestSealBoundary(t *testing.T) {
	s, clock := openTest(t, 10*time.Second)
	ts := baseTime()
	mustAdd(t, s, Event{ID: "e1", Ts: ts, Type: TypeText, Body: "封存中", Src: "pwa"})

	// 差 1 秒满窗口：不解锁
	clock.t = ts.Add(10*time.Second - time.Second)
	if _, ok := s.UnlockedEntry("e1"); ok {
		t.Fatal("ts+window-1s: should be locked")
	}
	entries, next, err := s.List("", 30)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 0 || next != "" {
		t.Fatalf("ts+window-1s: List = %d entries, next %q; want empty", len(entries), next)
	}
	sealed, unlocked := s.Counts()
	if sealed != 1 || unlocked != 0 {
		t.Fatalf("Counts = %d/%d; want 1/0", sealed, unlocked)
	}

	// 恰好满窗口：解锁
	clock.t = ts.Add(10 * time.Second)
	if _, ok := s.UnlockedEntry("e1"); !ok {
		t.Fatal("ts+window: should be unlocked")
	}
	entries, _, err = s.List("", 30)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 || entries[0].ID != "e1" {
		t.Fatalf("ts+window: List = %v; want [e1]", entries)
	}
	sealed, unlocked = s.Counts()
	if sealed != 0 || unlocked != 1 {
		t.Fatalf("Counts = %d/%d; want 0/1", sealed, unlocked)
	}
}

// 折叠逻辑：edit 覆盖 transcript，delete 隐藏。
func TestFold(t *testing.T) {
	s, clock := openTest(t, time.Second)
	ts := baseTime()
	mustAdd(t, s, Event{ID: "v1", Ts: ts, Type: TypeVoice, Media: "attachments/2026-09/v1.m4a", Src: "pwa"})

	e, _ := s.Entry("v1")
	if e.FoldedText() != nil {
		t.Fatalf("pending voice FoldedText = %v; want nil", *e.FoldedText())
	}
	if st, _ := e.TranscriptStatus(); st != "pending" {
		t.Fatalf("status = %q; want pending", st)
	}

	// transcript 落地 → 折叠出转写文本
	mustAppend(t, s, Event{Type: TypeTranscript, Ref: "v1", Ts: ts.Add(time.Second), Text: "原始转写", Engine: "sensevoice",
		Segments: []Segment{{T: 0.96, D: 4.22, Text: "原始转写"}}})
	if got := *e.FoldedText(); got != "原始转写" {
		t.Fatalf("FoldedText = %q; want 原始转写", got)
	}

	// edit 覆盖 transcript
	mustAppend(t, s, Event{Type: TypeEdit, Ref: "v1", Ts: ts.Add(2 * time.Second), Body: "校对后的文本"})
	if got := *e.FoldedText(); got != "校对后的文本" {
		t.Fatalf("after edit FoldedText = %q; want 校对后的文本", got)
	}
	if st, txt := e.TranscriptStatus(); st != "done" || txt != "校对后的文本" {
		t.Fatalf("TranscriptStatus = %q/%q; want done/校对后的文本", st, txt)
	}

	// delete：对 API 不可见（附件保留），计数剔除
	mustAppend(t, s, Event{Type: TypeDelete, Ref: "v1", Ts: ts.Add(3 * time.Second)})
	clock.t = ts.Add(time.Hour) // 早已解锁
	if _, ok := s.UnlockedEntry("v1"); ok {
		t.Fatal("deleted entry should be invisible")
	}
	if entries, _, _ := s.List("", 30); len(entries) != 0 {
		t.Fatalf("deleted entry in List: %v", entries)
	}
	if sealed, unlocked := s.Counts(); sealed != 0 || unlocked != 0 {
		t.Fatalf("Counts after delete = %d/%d; want 0/0", sealed, unlocked)
	}
	if !s.Has("v1") {
		t.Fatal("deleted id should still be reserved (Has=true)")
	}

	// 文本条目：body → edit 覆盖
	mustAdd(t, s, Event{ID: "t1", Ts: ts, Type: TypeText, Body: "一条笔记", Src: "shortcut-text"})
	et, _ := s.Entry("t1")
	if got := *et.FoldedText(); got != "一条笔记" {
		t.Fatalf("text entry FoldedText = %q; want 一条笔记", got)
	}
	mustAppend(t, s, Event{Type: TypeEdit, Ref: "t1", Ts: ts.Add(time.Second), Body: "改过的笔记"})
	if got := *et.FoldedText(); got != "改过的笔记" {
		t.Fatalf("after edit FoldedText = %q; want 改过的笔记", got)
	}

	// 转写失败：FoldedText 回落 nil，status=failed
	mustAdd(t, s, Event{ID: "v2", Ts: ts, Type: TypeVoice, Media: "attachments/2026-09/v2.m4a", Src: "pwa"})
	mustAppend(t, s, Event{Type: TypeTranscript, Ref: "v2", Ts: ts.Add(time.Second), Engine: EngineFailed})
	e2, _ := s.Entry("v2")
	if e2.FoldedText() != nil {
		t.Fatalf("failed voice FoldedText = %v; want nil", *e2.FoldedText())
	}
	if st, txt := e2.TranscriptStatus(); st != "failed" || txt != "" {
		t.Fatalf("TranscriptStatus = %q/%q; want failed/", st, txt)
	}
}

// 幂等去重：同 id 重复 capture 不重复落盘。
func TestDedup(t *testing.T) {
	s, _ := openTest(t, time.Second)
	ev := Event{ID: "d1", Ts: baseTime(), Type: TypeText, Body: "只落一次", Src: "shortcut-text"}
	dedup, err := s.AddEntry(ev)
	if err != nil || dedup {
		t.Fatalf("first AddEntry = (%v, %v); want (false, nil)", dedup, err)
	}
	dedup, err = s.AddEntry(ev)
	if err != nil || !dedup {
		t.Fatalf("second AddEntry = (%v, %v); want (true, nil)", dedup, err)
	}
	data, err := os.ReadFile(filepath.Join(s.dir, "log-2026-09.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if lines := strings.Count(strings.TrimSpace(string(data)), "\n") + 1; lines != 1 {
		t.Fatalf("log file has %d lines; want 1", lines)
	}
	clock := baseTime().Add(time.Hour)
	s.Now = func() time.Time { return clock }
	if entries, _, _ := s.List("", 30); len(entries) != 1 {
		t.Fatalf("List = %d entries; want 1", len(entries))
	}
}

// 跨月切分 + 重启全量重建：事件按各自 ts 归属月份文件。
func TestMonthlySplitAndRebuild(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, time.Second)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	aug := time.Date(2026, 8, 31, 23, 59, 59, 0, testZone)
	sep := time.Date(2026, 9, 1, 0, 0, 1, 0, testZone)
	mustAdd(t, s, Event{ID: "m1", Ts: aug, Type: TypeVoice, Media: "attachments/2026-08/m1.m4a", Src: "pwa"})
	mustAdd(t, s, Event{ID: "m2", Ts: sep, Type: TypeText, Body: "九月第一条", Src: "pwa"})
	// 转写事件本身发生在九月 → 归九月文件，虽然 ref 的条目在八月
	mustAppend(t, s, Event{Type: TypeTranscript, Ref: "m1", Ts: sep, Text: "八月末的话", Engine: "sensevoice"})
	mustAppend(t, s, Event{Type: TypeDelete, Ref: "m2", Ts: sep.Add(time.Minute)})

	augData, err := os.ReadFile(filepath.Join(dir, "log-2026-08.jsonl"))
	if err != nil {
		t.Fatalf("aug file: %v", err)
	}
	if n := strings.Count(strings.TrimSpace(string(augData)), "\n") + 1; n != 1 {
		t.Fatalf("aug file lines = %d; want 1", n)
	}
	sepData, err := os.ReadFile(filepath.Join(dir, "log-2026-09.jsonl"))
	if err != nil {
		t.Fatalf("sep file: %v", err)
	}
	if n := strings.Count(strings.TrimSpace(string(sepData)), "\n") + 1; n != 3 {
		t.Fatalf("sep file lines = %d; want 3", n)
	}

	// 重建：索引、折叠、删除、排序都要恢复
	s2, err := Open(dir, time.Second)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	s2.Now = func() time.Time { return sep.Add(time.Hour) }
	e1, ok := s2.Entry("m1")
	if !ok {
		t.Fatal("m1 lost after rebuild")
	}
	if got := *e1.FoldedText(); got != "八月末的话" {
		t.Fatalf("m1 FoldedText = %q; want 八月末的话", got)
	}
	e2, ok := s2.Entry("m2")
	if !ok || !e2.Deleted {
		t.Fatalf("m2 after rebuild: ok=%v deleted=%v; want deleted", ok, e2.Deleted)
	}
	entries, _, err := s2.List("", 30)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 || entries[0].ID != "m1" {
		t.Fatalf("List after rebuild = %v; want [m1]", entries)
	}
}

// 校对窗口：创建后 1h 内 transcript/PATCH 可见，entries 不可见；过后连校对入口也关闭。
func TestProofreadWindow(t *testing.T) {
	s, clock := openTest(t, 240*time.Hour)
	ts := baseTime()
	mustAdd(t, s, Event{ID: "p1", Ts: ts, Type: TypeVoice, Media: "attachments/2026-09/p1.m4a", Src: "pwa"})

	clock.t = ts.Add(59 * time.Minute)
	if _, ok := s.ProofreadEntry("p1"); !ok {
		t.Fatal("59min: proofread should be open")
	}
	if _, ok := s.UnlockedEntry("p1"); ok {
		t.Fatal("59min: should still be sealed")
	}

	clock.t = ts.Add(61 * time.Minute)
	if _, ok := s.ProofreadEntry("p1"); ok {
		t.Fatal("61min: proofread should be closed")
	}

	clock.t = ts.Add(240 * time.Hour)
	if _, ok := s.ProofreadEntry("p1"); !ok {
		t.Fatal("unlocked: proofread entry should be visible again")
	}
	if _, ok := s.UnlockedEntry("p1"); !ok {
		t.Fatal("240h: should be unlocked")
	}
}

// 重启补转写队列：无 transcript 的 voice 条目在列，failed 的不在列。
func TestPendingTranscription(t *testing.T) {
	s, _ := openTest(t, time.Second)
	ts := baseTime()
	mustAdd(t, s, Event{ID: "w1", Ts: ts, Type: TypeVoice, Media: "attachments/2026-09/w1.m4a", Src: "pwa"})
	mustAdd(t, s, Event{ID: "w2", Ts: ts, Type: TypeVoice, Media: "attachments/2026-09/w2.m4a", Src: "pwa"})
	mustAdd(t, s, Event{ID: "x1", Ts: ts, Type: TypeText, Body: "文本不参与", Src: "pwa"})
	mustAppend(t, s, Event{Type: TypeTranscript, Ref: "w2", Ts: ts, Engine: EngineFailed})

	ids := s.PendingTranscription()
	if len(ids) != 1 || ids[0] != "w1" {
		t.Fatalf("PendingTranscription = %v; want [w1]", ids)
	}
}
