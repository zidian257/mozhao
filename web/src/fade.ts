// 150ms 交叉淡入的文本替换：旧文本淡出、新文本淡入，层叠于同一网格。
// 这是 reduced-motion 下的默认形态，也是数字/计时器变化的唯一动画。
export function crossfadeText(container: HTMLElement, text: string): void {
  const stale = container.querySelectorAll<HTMLElement>('.fade-item');
  const next = document.createElement('span');
  next.className = 'fade-item fade-in';
  next.textContent = text;
  container.appendChild(next);
  stale.forEach((el) => {
    el.classList.remove('fade-in');
    el.classList.add('fade-out');
    window.setTimeout(() => el.remove(), 200);
  });
}
