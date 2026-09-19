import { animate } from 'motion';
import { prefersReducedMotion } from './reduced-motion';
import type { WaterScene } from './water';

// 仪式动画集中在这里：点按水波、封存下沉+涌波、取消蒸发。
// reduced-motion 时一律降级为 150ms 交叉淡化。

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 平台不支持 */
  }
}

// 点按瞬间：水波从按键中心荡开（scale 1→2.2，500ms，透明度 0.4→0）
export function playTapRipple(host: HTMLElement, fx: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const rect = host.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'tap-ripple';
  ring.style.left = `${rect.left + rect.width / 2}px`;
  ring.style.top = `${rect.top + rect.height / 2}px`;
  fx.appendChild(ring);
  window.setTimeout(() => ring.remove(), 550);
}

// WebGL 不可用时的 DOM 同心波纹兜底
function spawnDomRings(x: number, y: number, fx: HTMLElement): void {
  const scales = [1.6, 2.2, 2.8];
  const durations = [1000, 1150, 1300];
  scales.forEach((scale, i) => {
    const ring = document.createElement('div');
    ring.className = 'seal-ring';
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    ring.style.setProperty('--ring-scale', String(scale));
    ring.style.animationDuration = `${durations[i]}ms`;
    ring.style.animationDelay = `${i * 100}ms`;
    fx.appendChild(ring);
    window.setTimeout(() => ring.remove(), 1700);
  });
}

// 封存英雄动画：初速慢 → 重力加速 → 入水瞬间被水接住的阻尼，
// 同步 blur 加深 + scale 0.96；入水点触发 shader 涌波（+光线扭曲）。
// 全产品唯一超 1 秒的动画。
export async function playSeal(
  card: HTMLElement,
  fx: HTMLElement,
  water: WaterScene,
): Promise<void> {
  card.classList.remove('rise-reduced', 'quiet-out');
  if (prefersReducedMotion()) {
    card.classList.add('seal-fade');
    await wait(160);
    card.classList.remove('seal-fade');
    return;
  }
  const rect = card.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2 + 92; // 入水点：下坠位移 ~90pt 处
  vibrate(10);
  void animate(
    card,
    {
      y: [0, 76, 92],
      scale: [1, 0.975, 0.96],
      filter: ['blur(0px)', 'blur(1.5px)', 'blur(7px)'],
      opacity: [1, 0.97, 0.9],
    },
    {
      duration: 0.78,
      times: [0, 0.62, 1],
      // 第一段 ease-in 加速（重力），第二段 ease-out 急缓（被水接住）
      ease: [
        [0.55, 0.06, 0.72, 0.3],
        [0.18, 0.8, 0.32, 1],
      ],
    },
  );
  await wait(700);
  water.ripple(x, y, 2.2); // 石子入深水
  vibrate(8); // soft impact
  if (!water.active) spawnDomRings(x, y, fx);
  void animate(card, { opacity: 0 }, { duration: 0.28, ease: 'easeOut' });
  await wait(280);
  card.style.visibility = 'hidden';
  await wait(water.active ? 900 : 1250);
}

// 取消 = 向上蒸发：柔和发光微粒上浮，融入环境微粒场，消散更慢更轻
export async function playEvaporate(x: number, y: number, fx: HTMLElement): Promise<void> {
  if (prefersReducedMotion()) {
    await wait(150);
    return;
  }
  const count = 12;
  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('div');
    p.className = 'evap-particle';
    p.style.left = `${x + (Math.random() - 0.5) * 18}px`;
    p.style.top = `${y + (Math.random() - 0.5) * 8}px`;
    p.style.setProperty('--dx', `${((Math.random() - 0.5) * 40).toFixed(1)}px`);
    p.style.setProperty('--dy', `${(-(58 + Math.random() * 74)).toFixed(1)}px`);
    p.style.animationDelay = `${Math.floor(Math.random() * 80)}ms`;
    fx.appendChild(p);
    window.setTimeout(() => p.remove(), 720);
  }
  await wait(500);
}
