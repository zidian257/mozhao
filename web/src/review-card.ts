import { animate } from 'motion';
import { ApiError, deleteEntry, getTranscript, patchEntry } from './api';
import { flushQueue } from './queue';
import { prefersReducedMotion } from './reduced-motion';

export interface ReviewCallbacks {
  onSeal: () => void;
  onDiscard: () => void;
}

// 校对页：一次性。卡片 motion spring 升起（阻尼 ~0.75，温柔过冲），
// 轮询转写，文字直接可编辑，失焦/停顿即 PATCH。离开即封存。
export class ReviewCard {
  private entryId: string | null = null;
  private pollTimer = 0;
  private saveTimer = 0;
  private revealTimers: number[] = [];
  private savedText = '';
  private userEdited = false;
  private closed = true;
  private notFoundCount = 0;
  // 本条 capture 的上传结果：null=在途，true=已达服务端，false=进离线队列。
  // 404 轮询按此区分「真失败」与「还没到服务器」——后者主动补传并继续等
  private uploadSettled: boolean | null = null;

  constructor(
    private root: HTMLElement,
    private card: HTMLElement,
    private stateEl: HTMLElement,
    private textarea: HTMLTextAreaElement,
    sealBtn: HTMLButtonElement,
    discardBtn: HTMLButtonElement,
    cb: ReviewCallbacks,
  ) {
    sealBtn.addEventListener('click', () => cb.onSeal());
    discardBtn.addEventListener('click', () => cb.onDiscard());
    this.textarea.addEventListener('input', () => {
      this.userEdited = true;
      this.autosize();
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => void this.save(), 800);
    });
    this.textarea.addEventListener('blur', () => {
      window.clearTimeout(this.saveTimer);
      void this.save();
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  open(entryId: string, upload?: Promise<boolean>): void {
    this.entryId = entryId;
    this.closed = false;
    this.savedText = '';
    this.userEdited = false;
    this.notFoundCount = 0;
    this.uploadSettled = null;
    void (upload ?? Promise.resolve(true)).then((ok) => {
      this.uploadSettled = ok;
    });
    this.textarea.value = '';
    this.textarea.classList.remove('lit', 'pre-lit');
    this.stateEl.textContent = '转写中';
    this.stateEl.className = 'review-state is-pending';
    this.resetCardStyle();
    this.root.hidden = false;
    if (prefersReducedMotion()) {
      this.card.classList.add('rise-reduced');
    } else {
      void animate(
        this.card,
        { y: [56, 0], opacity: [0, 1] },
        { type: 'spring', stiffness: 285, damping: 24, mass: 0.92 },
      );
    }
    this.autosize();
    this.schedulePoll(900);
  }

  // 用户点「封存」前：把停顿计时器里未发的编辑先落库
  async flushSave(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    await this.save();
  }

  // 离开即封存：UI 收尾（best-effort keepalive PATCH + 停止轮询 + 收起）
  settleQuietly(): void {
    window.clearTimeout(this.saveTimer);
    if (this.userEdited && this.entryId) {
      const body = this.textarea.value;
      if (body !== this.savedText) {
        this.savedText = body;
        void patchEntry(this.entryId, body, true).catch(() => undefined);
      }
    }
    this.close();
  }

  // 丢弃：安静沉开，尽力 DELETE（锁定中的条目服务端可能拒绝，M1 接受）
  async discard(): Promise<void> {
    const id = this.entryId;
    if (prefersReducedMotion()) {
      this.card.classList.add('quiet-out');
      await new Promise((resolve) => {
        window.setTimeout(resolve, 160);
      });
    } else {
      void animate(this.card, { opacity: 0, y: 10 }, { duration: 0.18, ease: 'easeOut' });
      await new Promise((resolve) => {
        window.setTimeout(resolve, 190);
      });
    }
    this.close();
    if (id) {
      try {
        await deleteEntry(id);
      } catch {
        /* 服务端裁定不可删时静默 */
      }
    }
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.pollTimer);
    window.clearTimeout(this.saveTimer);
    this.revealTimers.forEach((t) => window.clearTimeout(t));
    this.revealTimers = [];
    this.card.querySelectorAll('.lines-reveal').forEach((el) => el.remove());
    this.root.hidden = true;
    this.card.classList.remove('rise-reduced', 'seal-fade', 'quiet-out');
    this.textarea.classList.remove('lit', 'pre-lit');
    this.resetCardStyle();
    this.entryId = null;
  }

  private resetCardStyle(): void {
    this.card.style.transform = '';
    this.card.style.filter = '';
    this.card.style.opacity = '';
    this.card.style.visibility = '';
  }

  // 转写亮出：逐行 150ms 交错淡入（overlay 落位后交换回可编辑 textarea）
  private revealLines(text: string): void {
    this.textarea.classList.add('pre-lit');
    const overlay = document.createElement('div');
    overlay.className = 'lines-reveal';
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const span = document.createElement('span');
      span.className = 'line';
      span.style.animationDelay = `${i * 45}ms`;
      span.textContent = line.length > 0 ? line : ' ';
      overlay.appendChild(span);
    });
    overlay.style.top = `${this.textarea.offsetTop}px`;
    overlay.style.left = `${this.textarea.offsetLeft}px`;
    overlay.style.width = `${this.textarea.offsetWidth}px`;
    this.card.appendChild(overlay);
    const swap = window.setTimeout(
      () => {
        this.textarea.classList.remove('pre-lit');
        this.textarea.classList.add('lit');
        overlay.classList.add('done');
        const cleanup = window.setTimeout(() => overlay.remove(), 240);
        this.revealTimers.push(cleanup);
      },
      lines.length * 45 + 220,
    );
    this.revealTimers.push(swap);
  }

  private schedulePoll(delay: number): void {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.closed || !this.entryId) return;
    try {
      const t = await getTranscript(this.entryId);
      if (this.closed) return;
      this.notFoundCount = 0;
      if (t.status === 'done') {
        this.stateEl.textContent = '';
        this.stateEl.className = 'review-state';
        if (!this.userEdited) {
          this.textarea.value = t.text;
          this.savedText = t.text;
          this.autosize();
          if (prefersReducedMotion()) this.textarea.classList.add('lit');
          else this.revealLines(t.text);
        } else {
          this.textarea.classList.add('lit');
        }
        return;
      }
      if (t.status === 'failed') {
        this.showFailed();
        return;
      }
      // pending：从离线等待态恢复为常规转写中文案
      if (this.stateEl.textContent !== '转写中') {
        this.stateEl.textContent = '转写中';
        this.stateEl.className = 'review-state is-pending';
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        if (this.uploadSettled === false) {
          // 上传失败进了离线队列：不是转写失败——主动补传，到库后照常转写
          this.stateEl.textContent = '已离线保存，联网后自动转写';
          this.stateEl.className = 'review-state is-pending';
          void flushQueue();
          this.schedulePoll(5000);
          return;
        }
        if (this.uploadSettled === null) {
          // 上传仍在途（弱网大文件）：不累计 404，继续等
          this.schedulePoll(2500);
          return;
        }
        // 条目不存在（上传已完成但服务端无记录，异常）：连续 3 次（约 6s）后落终态
        this.notFoundCount += 1;
        if (this.notFoundCount >= 3) {
          this.showFailed();
          return;
        }
      } else if (e instanceof ApiError && e.status === 401) {
        // token 输入被取消：放慢节奏，下轮轮询会再次询问
        this.schedulePoll(8000);
        return;
      }
      /* 离线：继续安静等待 */
    }
    this.schedulePoll(2500);
  }

  private showFailed(): void {
    this.stateEl.textContent = '转写失败，仍可封存';
    this.stateEl.className = 'review-state is-failed';
    this.textarea.classList.add('lit');
  }

  private async save(): Promise<void> {
    if (this.closed || !this.entryId || !this.userEdited) return;
    const body = this.textarea.value;
    if (body === this.savedText) return;
    try {
      await patchEntry(this.entryId, body);
      this.savedText = body;
    } catch {
      /* M1：编辑丢失是静默的 */
    }
  }

  private autosize(): void {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${this.textarea.scrollHeight}px`;
  }
}
