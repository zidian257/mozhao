import { setToken } from './token-store';

// 401 兜底：极简 token 输入（深色细环、无多余文案）。
// 确认 → 写入 obs.token → resolve(true)，调用方带新 token 重发；
// 取消 → resolve(false)，原请求按失败走既有安静降级。并发 401 共享同一次询问。
let inflight: Promise<boolean> | null = null;

export function promptForToken(): Promise<boolean> {
  if (!inflight) {
    inflight = ask().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function ask(): Promise<boolean> {
  const gate = document.getElementById('token-gate');
  const form = document.getElementById('token-form');
  const input = document.getElementById('token-input');
  const cancel = document.getElementById('token-cancel');
  if (
    !(gate instanceof HTMLElement) ||
    !(form instanceof HTMLFormElement) ||
    !(input instanceof HTMLInputElement) ||
    !(cancel instanceof HTMLButtonElement)
  ) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => {
      form.removeEventListener('submit', onSubmit);
      cancel.removeEventListener('click', onCancel);
      gate.hidden = true;
      input.value = '';
      input.blur();
      resolve(ok);
    };
    const onSubmit = (event: Event): void => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      setToken(value);
      done(true);
    };
    const onCancel = (): void => done(false);
    form.addEventListener('submit', onSubmit);
    cancel.addEventListener('click', onCancel);
    gate.hidden = false;
    input.focus();
  });
}
