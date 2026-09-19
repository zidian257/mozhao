// 构建后预压缩 dist 文本资源：生成 .br（brotli q11）与 .gz（level 9），
// 供 Go embed 静态服务按 Accept-Encoding 直接吐预压缩内容。
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'

const DIST = new URL('../dist/', import.meta.url).pathname
const EXTS = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt'])

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

let saved = 0
let raw = 0
for (const file of walk(DIST)) {
  const ext = file.slice(file.lastIndexOf('.'))
  if (!EXTS.has(ext) || file.endsWith('.br') || file.endsWith('.gz')) continue
  const buf = readFileSync(file)
  if (buf.length < 256) continue
  raw += buf.length
  const br = brotliCompressSync(buf, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  })
  const gz = gzipSync(buf, { level: 9 })
  writeFileSync(file + '.br', br)
  writeFileSync(file + '.gz', gz)
  saved += buf.length - br.length
}
console.log(`precompressed: ${raw}B raw, saved ${saved}B (brotli)`)
