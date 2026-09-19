import { acquireWakeLock, releaseWakeLock } from './wakelock';

export interface RecordResult {
  blob: Blob;
  dur: number;
}

// 契约顺序：audio/mp4 → audio/webm;codecs=opus → 浏览器默认
export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus'];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* 继续探测 */
    }
  }
  return undefined;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) {
      this.ctx = new Ctor();
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0; // 平滑由波形侧 EMA 做
      source.connect(this.analyser);
    }
    this.chunks = [];
    const mimeType = pickMimeType();
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);
    this.mediaRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.mediaRecorder.start();
    this.startedAt = performance.now();
    void acquireWakeLock();
  }

  get elapsed(): number {
    return this.startedAt > 0 ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  async stop(): Promise<RecordResult> {
    const mr = this.mediaRecorder;
    if (!mr) throw new Error('recorder not started');
    const type = mr.mimeType || 'audio/webm';
    await this.waitStop(mr);
    const dur = this.elapsed;
    const blob = new Blob(this.chunks, { type });
    this.cleanup();
    return { blob, dur };
  }

  async cancel(): Promise<void> {
    const mr = this.mediaRecorder;
    this.chunks = [];
    if (mr) await this.waitStop(mr);
    this.cleanup();
  }

  private async waitStop(mr: MediaRecorder): Promise<void> {
    if (mr.state === 'inactive') return;
    await new Promise<void>((resolve) => {
      mr.addEventListener('stop', () => resolve(), { once: true });
      mr.stop();
    });
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.analyser = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.startedAt = 0;
    void releaseWakeLock();
  }
}
