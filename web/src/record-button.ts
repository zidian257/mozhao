import { animate } from 'motion';
import { prefersReducedMotion } from './reduced-motion';

// 录音键：状态切换走 motion spring（scale/opacity 内联托管），rim/光晕走 CSS。
// 静息浮动在包裹层 #record-float 上做（rAF 正弦，±9pt、周期 6s），
// 叠加与浮动错相的等积形变晃动（scaleX/scaleY ±3%，周期 5.3s）——上升中的气泡。
// 第三层运动是 CSS 侧的膜边界形变（blob-morph 9s，border-radius ±7%），三层错相叠加出活物感。
// 高光视差经 CSS 变量 --par 传给伪元素。JS 侧仅 transform；reduced-motion 三层全停。
// 红线豁免：用户明确点名要"明显在浮"，幅度以不晕为上限。
const FLOAT_AMPLITUDE = 9;
const FLOAT_PERIOD_S = 6.0;
const WOBBLE_PERIOD_S = 5.3;
const WOBBLE_AMOUNT = 0.03;

export class RecordButton {
  private floating = false;
  private amp = 0;
  private floatT = 0;
  private lastT = 0;

  constructor(
    private btn: HTMLButtonElement,
    private floatEl: HTMLElement,
  ) {
    this.lastT = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(0.05, (now - this.lastT) / 1000);
      this.lastT = now;
      const targetAmp = this.floating && !prefersReducedMotion() ? FLOAT_AMPLITUDE : 0;
      this.amp += (targetAmp - this.amp) * Math.min(1, dt * 1.4);
      this.floatT += dt;
      const phase = (this.floatT * Math.PI * 2) / FLOAT_PERIOD_S;
      const engage = this.amp / FLOAT_AMPLITUDE; // 0..1，浮动启停时晃动同步淡入淡出
      const y = Math.sin(phase) * this.amp;
      const wob = Math.sin((this.floatT * Math.PI * 2) / WOBBLE_PERIOD_S + 1.2) * WOBBLE_AMOUNT * engage;
      this.floatEl.style.transform =
        `translateY(${y.toFixed(2)}px) scaleX(${(1 + wob).toFixed(4)}) scaleY(${(1 - wob).toFixed(4)})`;
      this.btn.style.setProperty('--par', (Math.sin(phase) * engage).toFixed(3));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 入场：从 +20pt 深处缓缓上浮归位 + 淡入（800ms easeOutQuint），归位后开始浮动
  enter(): void {
    if (prefersReducedMotion()) {
      this.btn.classList.add('enter-fade');
      this.floating = true; // reduced 时 amp 恒为 0，等价静止
      return;
    }
    void animate(
      this.btn,
      { y: [20, 0], opacity: [0, 1] },
      { duration: 0.8, ease: [0.23, 1, 0.32, 1] }, // --ease-out-quint
    ).then(() => {
      this.floating = true;
    });
  }

  // 点按触感：scale 0.96（随后被 toRecording / toIdle 的 spring 接管即为回弹）
  press(): void {
    if (prefersReducedMotion()) return;
    void animate(this.btn, { scale: 0.96 }, { duration: 0.1, ease: 'easeOut' });
  }

  toRecording(): void {
    this.floating = false;
    this.btn.classList.add('is-red');
    if (prefersReducedMotion()) {
      this.setScale(0.26);
      return;
    }
    void animate(this.btn, { scale: 0.26 }, { type: 'spring', stiffness: 340, damping: 24 });
  }

  toIdle(): void {
    this.floating = true;
    this.btn.classList.remove('is-red');
    if (prefersReducedMotion()) {
      this.setScale(1);
      this.btn.style.opacity = '1';
      return;
    }
    void animate(this.btn, { scale: 1, opacity: 1 }, { type: 'spring', stiffness: 300, damping: 22 });
  }

  toHidden(): void {
    this.floating = false;
    this.btn.classList.remove('is-red');
    if (prefersReducedMotion()) {
      this.btn.style.opacity = '0';
      return;
    }
    void animate(this.btn, { scale: 0.7, opacity: 0 }, { duration: 0.2, ease: 'easeOut' });
  }

  showIdle(): void {
    this.floating = true;
    this.btn.classList.remove('is-red');
    if (prefersReducedMotion()) {
      this.setScale(1);
      this.btn.style.opacity = '1';
      return;
    }
    void animate(
      this.btn,
      { scale: [0.7, 1], opacity: [0, 1] },
      { type: 'spring', stiffness: 280, damping: 22 },
    );
  }

  private setScale(scale: number): void {
    this.btn.style.transform = `scale(${scale})`;
  }
}
