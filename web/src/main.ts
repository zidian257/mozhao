import './style.css';
import { captureVoice, setToken } from './api';
import { enqueueCapture, flushQueue, initQueue } from './queue';
import { onReducedMotionChange, prefersReducedMotion } from './reduced-motion';
import { initWater } from './water';
import { RecordButton } from './record-button';
import { playEvaporate, playSeal, playTapRipple, vibrate } from './seal-anim';
import { acquireWakeLock } from './wakelock';
import { Recorder } from './recorder';
import type { RecordResult } from './recorder';
import { ReviewCard } from './review-card';
import { StatusLine } from './status';
import { Timer } from './timer';
import { ulid } from './ulid';
import { Waveform } from './waveform';
import type { Mode } from './types';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

// ?token=… 写入 localStorage 并从 URL 抹掉（Bearer 鉴权，开发模式可空）
const params = new URLSearchParams(window.location.search);
const urlToken = params.get('token');
if (urlToken) {
  setToken(urlToken);
  params.delete('token');
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
}

const app = el('app');
const hotzone = el('hotzone');
const recordBtn = el<HTMLButtonElement>('record-btn');
const waveformEl = el('waveform');
const timerEl = el('timer');
const finishBtn = el<HTMLButtonElement>('finish-btn');
const cancelBtn = el<HTMLButtonElement>('cancel-btn');
const statusLineEl = el('status-line');
el('build-tag').textContent = __BUILD_ID__;
const reviewScreen = el('review-screen');
const reviewCardEl = el('review-card');
const reviewStateEl = el('review-state');
const reviewTextEl = el<HTMLTextAreaElement>('review-text');
const sealBtn = el<HTMLButtonElement>('seal-btn');
const discardBtn = el<HTMLButtonElement>('discard-btn');
const fxLayer = el('fx');
const noticeEl = el('notice');

// 环境水景：同步初始化，渲染循环自驱动；与 recorder 完全解耦，永不阻塞录音
const water = initWater(el<HTMLCanvasElement>('water'));
if (!water.active) app.classList.add('no-water');

// reduced-motion：JS 侧降级仪式，CSS 侧 .reduced 降级过渡，shader 静态化
app.classList.toggle('reduced', prefersReducedMotion());
onReducedMotionChange((reduced) => {
  app.classList.toggle('reduced', reduced);
  water.setStatic(reduced);
});

let mode: Mode = 'idle';
let entryId: string | null = null;

const recorder = new Recorder();
const recordButton = new RecordButton(recordBtn, el('record-float'));
const waveform = new Waveform(waveformEl);
const timer = new Timer(timerEl, () => recorder.elapsed);
const status = new StatusLine(statusLineEl);

const review = new ReviewCard(
  reviewScreen,
  reviewCardEl,
  reviewStateEl,
  reviewTextEl,
  sealBtn,
  discardBtn,
  {
    onSeal: () => void sealCurrent(),
    onDiscard: () => void discardCurrent(),
  },
);

function setMode(next: Mode): void {
  mode = next;
  app.dataset.mode = next;
}

let noticeTimer = 0;
function showNotice(text: string): void {
  noticeEl.textContent = text;
  noticeEl.classList.add('show');
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => noticeEl.classList.remove('show'), 2600);
}

async function startRecording(x?: number, y?: number): Promise<void> {
  if (mode !== 'idle') return;
  mode = 'recording'; // 先占位：动画与渲染永远不阻塞启动
  const rect = recordBtn.getBoundingClientRect();
  const cx = x ?? rect.left + rect.width / 2;
  const cy = y ?? rect.top + rect.height / 2;
  water.ripple(cx, cy, 0.9); // 触点落下一圈温柔的同心波
  playTapRipple(recordBtn, fxLayer);
  recordButton.press();
  vibrate(6); // light impact
  try {
    await recorder.start();
  } catch {
    mode = 'idle';
    recordButton.toIdle();
    showNotice('麦克风不可用');
    return;
  }
  entryId = ulid();
  setMode('recording');
  recordButton.toRecording();
  waveform.start(recorder.analyser);
  timer.start();
}

async function finishRecording(): Promise<void> {
  if (mode !== 'recording') return;
  setMode('review');
  recordButton.toHidden();
  waveform.stop();
  timer.stop();
  let result: RecordResult;
  try {
    result = await recorder.stop();
  } catch {
    setMode('idle');
    recordButton.showIdle();
    return;
  }
  const id = entryId ?? ulid();
  entryId = null;
  review.open(id);
  void uploadOrQueue(id, result);
}

async function uploadOrQueue(id: string, result: RecordResult): Promise<void> {
  try {
    await captureVoice(id, result.blob, result.dur, 'pwa');
  } catch {
    await enqueueCapture({
      id,
      blob: result.blob,
      dur: result.dur,
      src: 'pwa',
      queuedAt: Date.now(),
    });
  }
}

async function cancelRecording(): Promise<void> {
  if (mode !== 'recording') return;
  setMode('idle');
  recordButton.toIdle();
  waveform.stop();
  timer.stop();
  const rect = recordBtn.getBoundingClientRect();
  void playEvaporate(rect.left + rect.width / 2, rect.top + rect.height / 2, fxLayer);
  await recorder.cancel(); // 条目直接丢弃，不上传
  entryId = null;
}

async function sealCurrent(): Promise<void> {
  if (mode !== 'review' || !review.isOpen) return;
  setMode('sealing');
  await review.flushSave();
  const ripples = playSeal(reviewCardEl, fxLayer, water);
  // 输入优先级高于表演：卡片入水后立刻回静息态，涌波在水景层散尽
  window.setTimeout(
    () => {
      review.close();
      setMode('idle');
      recordButton.showIdle();
    },
    prefersReducedMotion() ? 170 : 800,
  );
  await ripples;
  status.bump(); // 「已封存」数字悄悄 +1
  void flushQueue();
}

async function discardCurrent(): Promise<void> {
  if (mode !== 'review' || !review.isOpen) return;
  setMode('idle');
  recordButton.showIdle();
  await review.discard();
}

// 离开即封存：校对页在切后台/锁屏/关闭时视为封存（UI 收尾，条目早已落库）
function settleOnLeave(): void {
  if (mode === 'review' && review.isOpen) {
    review.settleQuietly();
    setMode('idle');
    recordButton.showIdle();
    void status.refresh();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') settleOnLeave();
  if (document.visibilityState === 'visible' && mode === 'recording') void acquireWakeLock();
});
window.addEventListener('pagehide', settleOnLeave);

// 下半屏整块为录音热区；pointerdown 即启动，不等抬起
hotzone.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  void startRecording(event.clientX, event.clientY);
});
recordBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  void startRecording(event.clientX, event.clientY);
});
recordBtn.addEventListener('click', () => void startRecording()); // 键盘 Enter/Space
finishBtn.addEventListener('click', () => void finishRecording());
cancelBtn.addEventListener('click', () => void cancelRecording());

// 入场：气泡从 +20pt 上浮归位（800ms），状态行灰字随后 150ms 淡入
statusLineEl.style.opacity = '0';
requestAnimationFrame(() => recordButton.enter());
window.setTimeout(
  () => {
    statusLineEl.style.opacity = '';
  },
  prefersReducedMotion() ? 300 : 950,
);

status.start();
initQueue();

// PWA 从后台切回不重载页面，可能一直跑旧包：回到前台时探测服务器 index.html 的
// 资源指纹（query 绕过 SW 缓存，直发网络），变了说明刚部署过，自动刷新一次换新。
// 10 分钟内最多刷一次，防部署中途的连环刷新。
let lastBundleCheck = 0;
function checkBundleVersion(): void {
  const now = Date.now();
  if (now - lastBundleCheck < 60_000) return; // 回到前台的频率足够低，这里再压一道
  lastBundleCheck = now;
  const current = document.querySelector<HTMLScriptElement>('script[type="module"]')?.src ?? '';
  if (!current) return;
  const reloadedAt = Number(sessionStorage.getItem('obs.reloadedAt') ?? 0);
  if (now - reloadedAt < 600_000) return;
  void fetch(`/?v=${now}`)
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      const m = html.match(/assets\/index-[\w-]+\.js/);
      if (m && !current.includes(m[0])) {
        sessionStorage.setItem('obs.reloadedAt', String(now));
        window.location.reload();
      }
    })
    .catch(() => undefined);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkBundleVersion();
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
