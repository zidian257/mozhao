// 30 根柱条自水面基线向上生长，左右镜像对称；中线下方为模糊倒影行。
// 每柱双级平滑：快级 EMA(α=0.32) 取振幅，慢级变系数追随（外侧更滞后）→ 错相水草感。
// 60fps rAF，仅改 transform。
const BAR_COUNT = 30;
const HALF = BAR_COUNT / 2;
const FAST_ALPHA = 0.32;

export class Waveform {
  private mainBars: HTMLElement[] = [];
  private reflBars: HTMLElement[] = [];
  private fast: number[] = new Array<number>(HALF).fill(0);
  private slow: number[] = new Array<number>(HALF).fill(0);
  private raf = 0;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;

  constructor(container: HTMLElement) {
    const main = document.createElement('div');
    main.className = 'wf-main';
    const wrap = document.createElement('div');
    wrap.className = 'wf-reflect-wrap';
    const reflect = document.createElement('div');
    reflect.className = 'wf-reflect';
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const bar = document.createElement('i');
      bar.className = 'wf-bar';
      main.appendChild(bar);
      this.mainBars.push(bar);
      const mirror = document.createElement('i');
      mirror.className = 'wf-bar';
      reflect.appendChild(mirror);
      this.reflBars.push(mirror);
    }
    wrap.appendChild(reflect);
    container.appendChild(main);
    container.appendChild(wrap);
  }

  start(analyser: AnalyserNode | null): void {
    this.analyser = analyser;
    this.data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    this.fast.fill(0);
    this.slow.fill(0);
    const tick = (): void => {
      this.update();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.analyser = null;
    this.data = null;
    for (const bar of [...this.mainBars, ...this.reflBars]) {
      bar.style.transform = 'scaleY(0.05)';
    }
  }

  private update(): void {
    if (this.analyser && this.data) {
      this.analyser.getByteFrequencyData(this.data);
      for (let i = 0; i < HALF; i += 1) {
        // 人声能量集中在低频段，柱条按幂律采样低中频 bin
        const bin = 2 + Math.floor(Math.pow(i / (HALF - 1), 1.35) * 46);
        const target = this.data[bin] / 255;
        this.fast[i] += FAST_ALPHA * (target - this.fast[i]);
        // 慢级：系数随柱条外移递减 → 外侧相位更滞后，像水草摆动
        const lagAlpha = 0.24 - (i / (HALF - 1)) * 0.13;
        this.slow[i] += lagAlpha * (this.fast[i] - this.slow[i]);
      }
    } else {
      for (let i = 0; i < HALF; i += 1) {
        this.fast[i] *= 0.82;
        this.slow[i] *= 0.9;
      }
    }
    for (let i = 0; i < HALF; i += 1) {
      const scale = 0.05 + Math.min(1, this.slow[i] * 1.5) * 0.95;
      const css = `scaleY(${scale.toFixed(3)})`;
      this.mainBars[HALF - 1 - i].style.transform = css;
      this.mainBars[HALF + i].style.transform = css;
      this.reflBars[HALF - 1 - i].style.transform = css;
      this.reflBars[HALF + i].style.transform = css;
    }
  }
}
