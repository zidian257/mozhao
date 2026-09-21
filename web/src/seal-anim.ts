import { prefersReducedMotion } from './reduced-motion';

// 仪式动画集中在这里：点按水波、取消蒸发。
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
