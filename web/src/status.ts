import { getStatus } from './api';
import { crossfadeText } from './fade';

// 底部常驻行：每次打开随机一句佛学箴言（crypto 随机，不加引号出处）。
// 完成一次封存后，切换为「已封存 N 条」作为"存上了"的确认，约 90 秒后交叉淡化回箴言；
// 下次打开也是箴言。401/离线降级同样落回箴言——这一行只有箴言或封存数两种内容。
// 每 30s 轮询 + 回到前台刷新 + 封存后 bump。
const VERSES = [
  '凡所有相，皆是虚妄',
  '应无所住，而生其心',
  '过去心不可得，现在心不可得，未来心不可得',
  '一切有为法，如梦幻泡影',
  '如露亦如电，应作如是观',
  '心无挂碍，无挂碍故，无有恐怖',
  '本来无一物，何处惹尘埃',
  '不是风动，不是幡动，仁者心动',
  '万古长空，一朝风月',
  '云在青天水在瓶',
  '春有百花秋有月，夏有凉风冬有雪',
  '溪声便是广长舌，山色岂非清净身',
] as const;

// 封存数确认停留时长：够用户余光扫到，又不会把箴言永久顶掉
const SEALED_ACK_MS = 90_000;

function pickVerse(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return VERSES[buf[0] % VERSES.length];
}

export class StatusLine {
  private count: number | null = null;
  private sealed = false;
  private shown = '';
  private ackTimer = 0;
  private readonly verse = pickVerse();

  constructor(private container: HTMLElement) {}

  start(): void {
    this.show(this.verse);
    void this.refresh();
    window.setInterval(() => void this.refresh(), 30_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    try {
      const status = await getStatus();
      // 确认窗内本地刚 +1 而服务端可能还没落完，计数不许往回退；窗外以服务端为准
      this.count = this.sealed ? Math.max(status.sealed_count, this.count ?? 0) : status.sealed_count;
      if (this.sealed) this.show(`已封存 ${this.count} 条`);
    } catch {
      // 离线/401：安静落回箴言
      if (!this.sealed) this.show(this.verse);
    }
  }

  bump(): void {
    this.sealed = true;
    this.count = (this.count ?? 0) + 1;
    this.show(`已封存 ${this.count} 条`);
    window.clearTimeout(this.ackTimer);
    this.ackTimer = window.setTimeout(() => {
      this.sealed = false;
      this.show(this.verse);
    }, SEALED_ACK_MS);
    void this.refresh();
  }

  private show(text: string): void {
    if (this.shown === text) return;
    this.shown = text;
    crossfadeText(this.container, text);
  }
}
