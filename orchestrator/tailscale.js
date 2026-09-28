// ボードを tailnet に公開する（tailscale serve）。インターネットには出さない（funnel は使わない）。
// HTTPS 証明書が tailnet で有効なら https://<machine>.<tailnet>.ts.net:<port>/、なければ http:// で公開する。
// どちらも通信は WireGuard で暗号化される。
//
// CLI の場所:
//   ATV_TAILSCALE_BIN / ATV_TAILSCALE_SOCKET があればそれを使う。なければ macOS アプリ同梱の CLI、
//   PATH の tailscale、root なしの userspace 版（~/tailscale-user/）の順に探す。
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function locate() {
  if (process.env.ATV_TAILSCALE_BIN) return { bin: process.env.ATV_TAILSCALE_BIN, socket: process.env.ATV_TAILSCALE_SOCKET || null };
  const onPath = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'tailscale')).find((p) => fs.existsSync(p));
  // macOS ではアプリ同梱の CLI を先に使う（/usr/local/bin/tailscale 経由だとアプリの識別に失敗して落ちることがある）
  const candidates = [
    { bin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' },
    onPath && { bin: onPath },
    { bin: path.join(os.homedir(), 'tailscale-user', 'tailscale'), socket: path.join(os.homedir(), 'tailscale-user', 'tailscaled.sock') },
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c.bin) && (!c.socket || fs.existsSync(c.socket)));
  if (!found) return null;
  return { bin: found.bin, socket: process.env.ATV_TAILSCALE_SOCKET || found.socket || null };
}

function run(ts, args, timeout = 20000) {
  const full = ts.socket ? [`--socket=${ts.socket}`, ...args] : args;
  return new Promise((resolve) => {
    execFile(ts.bin, full, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
}

// 公開して { url, off() } を返す。失敗したら { error, enableUrl? }
async function share(port) {
  const ts = locate();
  if (!ts) return { error: 'tailscale CLI が見つからない（ATV_TAILSCALE_BIN で場所を指定できる）' };
  const st = await run(ts, ['status', '--json']);
  if (!st.ok) return { error: `tailscale に接続できない: ${st.out.slice(0, 200)}` };
  let self, https;
  try {
    const d = JSON.parse(st.out);
    self = d.Self.DNSName.replace(/\.$/, '');
    https = (d.CertDomains || []).length > 0;
  } catch { return { error: 'tailscale status を読めない' }; }

  const scheme = https ? 'https' : 'http';
  const r = await run(ts, ['serve', '--bg', `--${scheme}=${port}`, `http://127.0.0.1:${port}`]);
  if (!r.ok) {
    // Serve が tailnet で無効なときは、有効化用の URL が出る
    const enableUrl = (r.out.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0];
    return { error: `tailscale serve に失敗: ${r.out.slice(0, 300)}`, enableUrl };
  }
  return {
    url: `${scheme}://${self}:${port}/`,
    off: () => run(ts, ['serve', `--${scheme}=${port}`, 'off'], 10000),
  };
}

module.exports = { share, locate };
