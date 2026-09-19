// ULID（Crockford base32，48bit 时间 + 80bit 随机），客户端生成，服务端幂等去重。
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  const out = new Array<string>(26);
  let t = now;
  for (let i = 9; i >= 0; i -= 1) {
    out[i] = CROCKFORD[t % 32];
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  for (let i = 10; i < 26; i += 1) {
    out[i] = CROCKFORD[rand[i - 10] % 32];
  }
  return out.join('');
}
