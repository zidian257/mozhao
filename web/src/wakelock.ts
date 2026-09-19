// Wake Lock：录音中持有，页面回到前台时由调用方重新获取。
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

let sentinel: WakeLockSentinelLike | null = null;

function wakeLockApi(): WakeLockLike | null {
  const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
  return nav.wakeLock ?? null;
}

export async function acquireWakeLock(): Promise<void> {
  const api = wakeLockApi();
  if (!api || sentinel) return;
  try {
    sentinel = await api.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    sentinel = null;
  }
}

export async function releaseWakeLock(): Promise<void> {
  const current = sentinel;
  sentinel = null;
  if (current) {
    try {
      await current.release();
    } catch {
      /* 已释放 */
    }
  }
}
