import { captureVoice } from './api';

// 离线队列：capture 失败进 IndexedDB，online / visibilitychange 时补传。
// 同 id 重复上传由服务端幂等去重。
export interface QueuedCapture {
  id: string;
  blob: Blob;
  dur: number;
  src: string;
  queuedAt: number;
}

const DB_NAME = 'observer';
const STORE = 'queue';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

function toPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb error'));
  });
}

export async function enqueueCapture(item: QueuedCapture): Promise<void> {
  try {
    const db = await openDb();
    await toPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(item));
    db.close();
  } catch {
    /* 存储不可用时静默丢弃 */
  }
}

export async function flushQueue(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  let items: QueuedCapture[];
  try {
    items = (await toPromise(
      db.transaction(STORE, 'readonly').objectStore(STORE).getAll(),
    )) as QueuedCapture[];
  } catch {
    db.close();
    return;
  }
  for (const item of items) {
    try {
      await captureVoice(item.id, item.blob, item.dur, item.src);
      await toPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(item.id));
    } catch {
      break; // 仍不可达，留待下次
    }
  }
  db.close();
}

export function initQueue(): void {
  window.addEventListener('online', () => void flushQueue());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushQueue();
  });
  void flushQueue();
}
