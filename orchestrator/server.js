// ボードの配信とリアルタイム更新。
//   GET  /             … ボード（index.html ほか静的ファイル）
//   GET  /api/state    … 現在の状態 JSON
//   GET  /api/events   … Server-Sent Events。状態が変わるたびに全体を送る（250ms で間引き）
//   POST /api/control  … {action: pause|resume|unfreeze|unhold|protect-ok|restart|report|retry|approve, taskId?, epicId?}
//   POST /api/requests/:id … {reply?, dismiss?} 人間への依頼に返答する
// 127.0.0.1 のみで待ち受ける（認証なしのため外に出さない）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serve(orch, { port, host = '127.0.0.1' }) {
  const clients = new Set();
  let pending = null;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const data = `data: ${JSON.stringify(orch.state)}\n\n`;
      for (const res of clients) res.write(data);
    }, 250);
  };
  orch.on('change', broadcast);
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/state') return json(res, 200, orch.state);
      if (url.pathname === '/api/report') {
        const p = orch.state.run.report?.path;
        if (!p || !fs.existsSync(p)) return json(res, 404, { error: 'まだ報告書がない' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
        return fs.createReadStream(p).pipe(res);
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(orch.state)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/control') {
        const body = await readBody(req);
        orch.control(body.action, body);
        return json(res, 200, { ok: true });
      }
      const m = url.pathname.match(/^\/api\/requests\/([\w-]+)$/);
      if (req.method === 'POST' && m) {
        orch.resolveRequest(m[1], await readBody(req));
        return json(res, 200, { ok: true });
      }

      // 静的ファイル（リポジトリ直下のボードのみ。orchestrator/ や .atv/ は出さない）
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(ROOT, rel);
      const allowed = file === path.join(ROOT, 'index.html') || file === path.join(ROOT, 'styles.css') || file.startsWith(path.join(ROOT, 'js') + path.sep);
      if (!allowed || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { serve };
