// 保護パス（既定は対象 repo の元の作業ツリー）への書き込みを塞ぐ。指示文だけに頼らないための 2 段構え:
//   1. 防ぐ: bwrap が使えれば、エージェントを「保護パスは読み取り専用、自分の cwd と .git だけ書ける」
//      マウント名前空間で動かす。Bash 経由（python・リダイレクト）の書き込みもカーネルが EROFS で止める。
//      Ubuntu 24.04 以降は AppArmor が非特権の user namespace を止めるので、bwrap 用のプロファイルが要る（README）
//   2. 見つける: bwrap の有無にかかわらず、保護パスのうち git 作業ツリーのものを数秒ごとに git status で見張る。
//      起動時から変化があれば新規 spawn を止め、その時動いていた task を添えて人間に知らせる（自動では消さない）
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
});

// bwrap で読み取り専用の bind を作れるか（作れないなら「見つける」だけで動く）
function bwrapWorks(bin = 'bwrap') {
  try {
    execFileSync(bin, ['--dev-bind', '/', '/', '--ro-bind', '/tmp', '/tmp', '--', 'true'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}

class Protector {
  // paths: 保護するディレクトリ。gitDir: 対象 repo の .git（worktree のコミットに要るので書けるようにする）
  constructor({ paths, gitDir, bwrap = 'auto', ignore = [] }) {
    this.paths = [...new Set(paths.map((p) => path.resolve(p)).filter((p) => fs.existsSync(p)))];
    this.gitDir = gitDir && path.resolve(gitDir);
    this.ignore = ignore; // 監視から外す repo 相対パスの接頭辞（.atv/ など）
    this.mode = bwrap === 'off' ? 'watch' : bwrapWorks() ? 'bwrap' : 'watch';
    this.baseline = new Map();
  }

  // エージェントのコマンドを包む。cwd（とその下）と .git だけは書ける
  wrap(cmd, args, cwd) {
    if (this.mode !== 'bwrap') return [cmd, args];
    const rw = [cwd, this.gitDir].filter(Boolean).map((p) => path.resolve(p));
    return ['bwrap', [
      '--dev-bind', '/', '/',
      ...this.paths.flatMap((p) => ['--ro-bind', p, p]),
      ...rw.flatMap((p) => ['--bind', p, p]),
      '--die-with-parent', '--', cmd, ...args,
    ]];
  }

  // 指示文に入れる 1 段落
  text() {
    return `Protected paths (read-only for you${this.mode === 'bwrap' ? ', enforced by the OS' : '; any change is detected and stops the run'}): ${this.paths.join(', ')}. Never cd into them to create or modify files, not even via scripts. Your writable repository copy is your current directory.`;
  }

  // 保護パスのうち git 作業ツリーの「未コミットの変化」の指紋: path → status|mtime|size
  async snapshot() {
    const snap = new Map();
    for (const root of this.paths) {
      const out = await run('git', ['-C', root, 'status', '--porcelain=v1', '-uall', '-z'], root);
      if (out == null) continue; // git 作業ツリーでなければ bwrap だけに任せる
      for (const rec of out.split('\0').filter(Boolean)) {
        const rel = rec.slice(3);
        if (this.ignore.some((x) => rel === x.replace(/\/$/, '') || rel.startsWith(x))) continue;
        const abs = path.join(root, rel);
        let st = '';
        try { const s = fs.statSync(abs); st = `${s.mtimeMs}|${s.size}`; } catch { st = 'gone'; }
        snap.set(abs, `${rec.slice(0, 2)}|${st}`);
      }
    }
    return snap;
  }

  async rebaseline() { this.baseline = await this.snapshot(); }

  // 起動時（か最後に人間が了承した時点）から変わったパス
  async changes() {
    const now = await this.snapshot();
    const out = [];
    for (const [p, v] of now) if (this.baseline.get(p) !== v) out.push(p);
    for (const p of this.baseline.keys()) if (!now.has(p)) out.push(p);
    return out;
  }
}

module.exports = { Protector, bwrapWorks };
