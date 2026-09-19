#!/usr/bin/env bash
# 下载并编译 sensevoice.cpp（Metal 加速），拉取 SenseVoiceSmall fp16 GGUF 模型。
# 用法: scripts/install-sensevoice.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VENDOR="$ROOT/vendor/sensevoice"
mkdir -p "$VENDOR"

if [ ! -d "$VENDOR/SenseVoice.cpp" ]; then
  git clone --depth 1 https://github.com/lovemefan/SenseVoice.cpp "$VENDOR/SenseVoice.cpp"
fi
cd "$VENDOR/SenseVoice.cpp"
git submodule update --init --recursive
mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j 8

cd "$ROOT"
# 模型与示例音频（幂等，已存在则跳过）
MODEL_DIR="$VENDOR/models"
mkdir -p "$MODEL_DIR"
[ -f "$MODEL_DIR/sense-voice-small-fp16.gguf" ] || \
  curl -L --retry 3 -o "$MODEL_DIR/sense-voice-small-fp16.gguf" \
  https://huggingface.co/lovemefan/sense-voice-gguf/resolve/main/sense-voice-small-fp16.gguf
[ -f "$MODEL_DIR/asr_example_zh.wav" ] || \
  curl -L --retry 3 -o "$MODEL_DIR/asr_example_zh.wav" \
  https://huggingface.co/lovemefan/sense-voice-gguf/resolve/main/asr_example_zh.wav

BIN="$VENDOR/SenseVoice.cpp/build/bin/sense-voice-main"
echo "== 自测 =="
"$BIN" -m "$MODEL_DIR/sense-voice-small-fp16.gguf" -f "$MODEL_DIR/asr_example_zh.wav" -t 4 -l auto -itn
echo "OK: $BIN"
