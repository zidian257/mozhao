// 最小 mock：仅用于前端验收（返回契约形状的 /api/*）。真实服务端是 Go 二进制。
import http from 'node:http';

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost:8787');
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/api/status' && req.method === 'GET') {
    json(200, { sealed_count: 12, unlocked_count: 0, has_unlocked: false, seal_window: '240h' });
    return;
  }
  if (url.pathname === '/api/capture' && req.method === 'POST') {
    req.resume();
    req.on('end', () => json(200, { id: '01JMOCK00000000000000000', dedup: false }));
    return;
  }
  if (/^\/api\/entries\/[^/]+\/transcript$/.test(url.pathname) && req.method === 'GET') {
    json(200, { status: 'done', text: '这是一段示例转写。' });
    return;
  }
  if (/^\/api\/entries\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
    req.resume();
    req.on('end', () => {
      res.writeHead(204);
      res.end();
    });
    return;
  }
  json(404, {});
});

const PORT = Number(process.env.OBS_MOCK_PORT ?? 8787);
const HOST = process.env.OBS_MOCK_HOST ?? '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`mock listening on ${HOST}:${PORT}`);
});
