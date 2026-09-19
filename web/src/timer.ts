import { crossfadeText } from './fade';

// 录音计时器：等宽数字，每秒交叉淡化，不跳。
export class Timer {
  private interval = 0;
  private lastSecond = -1;

  constructor(
    private container: HTMLElement,
    private elapsed: () => number,
  ) {}

  start(): void {
    this.lastSecond = -1;
    this.tick();
    this.interval = window.setInterval(() => this.tick(), 200);
  }

  stop(): void {
    window.clearInterval(this.interval);
    this.container.textContent = '';
  }

  private tick(): void {
    const second = Math.floor(this.elapsed());
    if (second === this.lastSecond) return;
    this.lastSecond = second;
    const m = Math.floor(second / 60);
    const s = (second % 60).toString().padStart(2, '0');
    crossfadeText(this.container, `${m}:${s}`);
  }
}
