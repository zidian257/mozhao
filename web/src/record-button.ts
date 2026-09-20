import { animate } from 'motion';
import { prefersReducedMotion } from './reduced-motion';
import type { WaterScene } from './water';

// 录音键：状态切换走 motion spring（scale/opacity 内联托管）。
// 视觉作画在 shader（water.ts）：本类的 rAF 每帧把按钮的实时包围盒（含浮动位移、
// motion 弹簧缩放、enter/隐藏的透明度意图）换算推给 water.setBubble——
// 弹簧怎么动，shader 泡泡就怎么动，两处永远不错相。
// 静息浮动在包裹层 #record-float 上做（rAF 正弦，幅度 = 直径 8%、周期 6s），
// 叠加与浮动错相的等积形变晃动（scaleX/scaleY ±3%，周期 5.3s）——上升中的气泡。
// 膜边界形变/虹彩/录音红核已由 shader 接管；reduced-motion 三层全停。
// rec（膜→红核）与 alpha（显隐）在这里做指数趋近，时长对齐原 CSS 300ms 过渡。
// 红线豁免：用户明确点名要"明显在浮"，幅度以不晕为上限。
const FLOAT_AMP_RATIO = 0.08; // 直径占比：112pt 时 ≈9pt，150pt 时 ≈12pt
const FLOAT_PERIOD_S = 6.0;
const WOBBLE_PERIOD_S = 5.3;
const WOBBLE_AMOUNT = 0.03;

export class RecordButton {
  private floating = false;
  private amp = 0;
  private floatT = 0;
  private lastT = 0;
  private rec = 0;
  private recTarget = 0;
  private alpha = 0;
  private alphaTarget = 0;

  constructor(
    private btn: HTMLButtonElement,
    private floatEl: HTMLElement,
    private water: WaterScene,
  ) {
    this.lastT = performance.now();
    const step = (nowMs: number): void => {
      const dt = Math.min(0.05, (nowMs - this.lastT) / 1000);
      this.lastT = nowMs;
      const fullAmp = this.floatEl.clientWidth * FLOAT_AMP_RATIO;
      const targetAmp = this.floating && !prefersReducedMotion() ? fullAmp : 0;
      this.amp += (targetAmp - this.amp) * Math.min(1, dt * 1.4);
      this.floatT += dt;
      const phase = (this.floatT * Math.PI * 2) / FLOAT_PERIOD_S;
      const engage = fullAmp > 0 ? this.amp / fullAmp : 0; // 0..1，浮动启停时晃动同步淡入淡出
      const y = Math.sin(phase) * this.amp;
      const wob = Math.sin((this.floatT * Math.PI * 2) / WOBBLE_PERIOD_S + 1.2) * WOBBLE_AMOUNT * engage;
      this.floatEl.style.transform =
        `translateY(${y.toFixed(2)}px) scaleX(${(1 + wob).toFixed(4)}) scaleY(${(1 - wob).toFixed(4)})`;
      // rec/alpha 指数趋近（~250/180ms 手感，对齐原 CSS 300ms 过渡）
      this.rec += (this.recTarget - this.rec) * Math.min(1, dt * 4.0);
      this.alpha += (this.alphaTarget - this.alpha) * Math.min(1, dt * 5.6);
      // 包围盒已含 floatEl 位移/晃动与 btn 上的 motion 弹簧缩放，是泡泡的唯一事实源
      const rect = this.btn.getBoundingClientRect();
      this.water.setBubble(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        this.rec,
        this.alpha,
        Math.sin(phase) * engage,
      );
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 入场：从 +20pt 深处缓缓上浮归位 + 淡入（800ms easeOutQuint），归位后开始浮动
  enter(): void {
    this.alphaTarget = 1;
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
    this.recTarget = 1;
    this.btn.classList.add('is-red');
    if (prefersReducedMotion()) {
      this.setScale(0.26);
      return;
    }
    void animate(this.btn, { scale: 0.26 }, { type: 'spring', stiffness: 340, damping: 24 });
  }

  toIdle(): void {
    this.floating = true;
    this.recTarget = 0;
    this.alphaTarget = 1;
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
    this.recTarget = 0;
    this.alphaTarget = 0;
    this.btn.classList.remove('is-red');
    if (prefersReducedMotion()) {
      this.btn.style.opacity = '0';
      return;
    }
    void animate(this.btn, { scale: 0.7, opacity: 0 }, { duration: 0.2, ease: 'easeOut' });
  }

  showIdle(): void {
    this.floating = true;
    this.recTarget = 0;
    this.alphaTarget = 1;
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
