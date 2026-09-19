package stt

import (
	"math"
	"os"
	"testing"
)

// 契约格式：`[0.96-5.18] <|zh|><|NEUTRAL|><|Speech|><|withitn|>文本`。
func TestParseSenseVoiceOutput(t *testing.T) {
	out := `sense_voice_small: processing 160000 samples, 3.5 sec, 45.9x realtime
[0.96-5.18] <|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气不错
[5.18-7.52] <|zh|><|NEUTRAL|><|Speech|><|withitn|>我们出去走了走
[7.52-8.00] <|zh|><|NEUTRAL|><|Speech|><|withitn|>
`
	segs := parseSenseVoiceOutput(out)
	if len(segs) != 2 {
		t.Fatalf("segments = %d; want 2 (%v)", len(segs), segs)
	}
	if segs[0].T != 0.96 || math.Abs(segs[0].D-4.22) > 1e-6 || segs[0].Text != "今天天气不错" {
		t.Fatalf("seg[0] = %+v", segs[0])
	}
	if segs[1].T != 5.18 || math.Abs(segs[1].D-2.34) > 1e-6 || segs[1].Text != "我们出去走了走" {
		t.Fatalf("seg[1] = %+v", segs[1])
	}

	if segs := parseSenseVoiceOutput("no transcript here\n"); len(segs) != 0 {
		t.Fatalf("garbage output parsed: %v", segs)
	}
}

// whisper-cli -oj 输出：offsets 毫秒→秒换算、前导/尾部空白清理、
// [_BEG_] 等特殊 token 不进文本、纯空白段丢弃、空转写判失败。
func TestParseWhisperJSON(t *testing.T) {
	data, err := os.ReadFile("testdata/whisper-output.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	res, err := parseWhisperJSON(data)
	if err != nil {
		t.Fatalf("parseWhisperJSON: %v", err)
	}
	if res.Engine != EngineWhisper {
		t.Fatalf("Engine = %q; want %q", res.Engine, EngineWhisper)
	}
	if res.Text != "欢迎大家来体验达摩院推出的语音识别模型。" {
		t.Fatalf("Text = %q", res.Text)
	}
	if len(res.Segments) != 2 {
		t.Fatalf("Segments = %d; want 2 (%v)", len(res.Segments), res.Segments)
	}
	s0, s1 := res.Segments[0], res.Segments[1]
	if s0.T != 0 || math.Abs(s0.D-2.96) > 1e-6 || s0.Text != "欢迎大家来体验达摩院推出的" {
		t.Fatalf("seg[0] = %+v", s0)
	}
	if s1.T != 2.96 || math.Abs(s1.D-2.22) > 1e-6 || s1.Text != "语音识别模型。" {
		t.Fatalf("seg[1] = %+v", s1)
	}

	if _, err := parseWhisperJSON([]byte(`{"transcription":[]}`)); err == nil {
		t.Fatal("empty transcription should fail")
	}
	if _, err := parseWhisperJSON([]byte(`not json`)); err == nil {
		t.Fatal("garbage should fail")
	}
	if _, err := parseWhisperJSON([]byte(`{"transcription":[{"offsets":{"from":0,"to":100},"text":"[_BEG_] "}]}`)); err == nil {
		t.Fatal("token-only transcription should fail")
	}
}

// 引擎选择与超时默认值。
func TestEngineDefaults(t *testing.T) {
	tr := &Transcriber{}
	if tr.engine() != EngineWhisper {
		t.Fatalf("zero-value engine = %q; want whisper", tr.engine())
	}
	if got := tr.timeout(0); got != 0 {
		t.Fatalf("timeout passthrough = %v", got)
	}
	tr.Engine = EngineSenseVoice
	if b, _ := tr.localPaths(); b != "" {
		t.Fatalf("sensevoice bin = %q; want empty", b)
	}
	tr.SenseVoiceBin = "/x/sense-voice-main"
	if b, _ := tr.localPaths(); b != "/x/sense-voice-main" {
		t.Fatalf("sensevoice bin = %q", b)
	}
}
