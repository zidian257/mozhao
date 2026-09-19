const mq = window.matchMedia('(prefers-reduced-motion: reduce)');

export function prefersReducedMotion(): boolean {
  return mq.matches;
}

export function onReducedMotionChange(cb: (reduced: boolean) => void): void {
  mq.addEventListener('change', () => cb(mq.matches));
}
