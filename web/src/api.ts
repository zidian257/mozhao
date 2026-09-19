import type { CaptureResponse, StatusResponse, TranscriptResponse } from './types';
import { promptForToken } from './token-prompt';
import { getToken } from './token-store';

export { setToken } from './token-store';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what} ${status}`);
  }
}

function headers(base?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(base ?? {}) };
  const token = getToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

// 401 → 弹 token 输入（写 localStorage）→ 带新 token 重发；取消则原样返回 401
async function request(
  path: string,
  init: RequestInit,
  base?: Record<string, string>,
): Promise<Response> {
  for (;;) {
    const res = await fetch(path, { ...init, headers: headers(base) });
    if (res.status !== 401) return res;
    const retry = await promptForToken();
    if (!retry) return res;
  }
}

function ensureOk(res: Response, what: string): void {
  if (!res.ok) throw new ApiError(res.status, what);
}

export async function getStatus(): Promise<StatusResponse> {
  const res = await request('/api/status', {});
  ensureOk(res, 'status');
  return (await res.json()) as StatusResponse;
}

export function audioExt(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'bin';
}

export async function captureVoice(
  id: string,
  blob: Blob,
  dur: number,
  src = 'pwa',
): Promise<CaptureResponse> {
  const form = new FormData();
  form.append('audio', blob, `${id}.${audioExt(blob.type)}`);
  form.append('id', id);
  form.append('dur', dur.toFixed(3));
  form.append('src', src);
  const res = await request('/api/capture', { method: 'POST', body: form });
  ensureOk(res, 'capture');
  return (await res.json()) as CaptureResponse;
}

export async function getTranscript(id: string): Promise<TranscriptResponse> {
  const res = await request(`/api/entries/${encodeURIComponent(id)}/transcript`, {});
  ensureOk(res, 'transcript');
  return (await res.json()) as TranscriptResponse;
}

export async function patchEntry(id: string, body: string, keepalive = false): Promise<void> {
  const res = await request(
    `/api/entries/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ body }), keepalive },
    { 'Content-Type': 'application/json' },
  );
  ensureOk(res, 'patch');
}

export async function deleteEntry(id: string): Promise<void> {
  const res = await request(`/api/entries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  ensureOk(res, 'delete');
}
