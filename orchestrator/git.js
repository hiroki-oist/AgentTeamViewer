// git worktree の管理。
//   atv/<runId>/main           … 統合ブランチ（<repo>/.atv/<runId>/main に worktree）
//   atv/<runId>/task/<id>-a<n> … task の試行ごとのブランチ（統合ブランチの先端から切る）
// ユーザーの作業ツリーには一切触らない。終わったら統合ブランチを自分でマージする。
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`.trim()));
      resolve({ ok: !err, out: stdout.trim(), err: stderr.trim() });
    });
  });
}

// "dir/" は配下すべて。locks.conflicts と同じ規則で、書いてよい範囲かを判定する
const covered = (file, writeSet) => writeSet.some((p) => p === file || (p.endsWith('/') && file.startsWith(p)));

class Repo {
  constructor(repoPath, runId) {
    this.runId = runId;
    this.input = path.resolve(repoPath);
    this.mergeChain = Promise.resolve();
  }

  async prepare() {
    this.root = (await git(this.input, ['rev-parse', '--show-toplevel'])).out;
    this.dir = path.join(this.root, '.atv', this.runId);
    this.mainBranch = `atv/${this.runId}/main`;
    this.mainPath = path.join(this.dir, 'main');
    fs.mkdirSync(this.dir, { recursive: true });

    // .atv/ を git に見せない（ユーザーの .gitignore は変更しない）
    const exclude = path.join(path.resolve(this.root, (await git(this.root, ['rev-parse', '--git-common-dir'])).out), 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.split('\n').includes('.atv/')) fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.atv/\n`);

    const dirty = (await git(this.root, ['status', '--porcelain'])).out;
    this.baseSha = (await git(this.root, ['rev-parse', 'HEAD'])).out;
    if (!fs.existsSync(this.mainPath)) await git(this.root, ['worktree', 'add', '-b', this.mainBranch, this.mainPath, this.baseSha]);
    this.headSha = await this.head();

    // コミット者が未設定の環境でも commit できるようにする（設定済みならそちらを使う）
    const name = (await git(this.root, ['config', 'user.name'], { allowFail: true })).out;
    this.identity = name ? [] : ['-c', 'user.name=ATV Orchestrator', '-c', 'user.email=atv@localhost'];
    return { dirty: Boolean(dirty) };
  }

  head() { return git(this.mainPath, ['rev-parse', 'HEAD']).then((r) => r.out); }

  async createTaskWorktree(taskId, attemptNo) {
    const branch = `atv/${this.runId}/task/${taskId}-a${attemptNo}`;
    const wtPath = path.join(this.dir, 'tasks', `${taskId}-a${attemptNo}`);
    const base = await this.head();
    await git(this.root, ['branch', '-D', branch], { allowFail: true });
    if (fs.existsSync(wtPath)) await git(this.root, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
    await git(this.root, ['worktree', 'add', '-b', branch, wtPath, base]);
    return { branch, path: wtPath, base };
  }

  // 作業結果を commit し、base からの変更ファイルを返す（エージェントが自分で commit していても拾う）
  async commitAll(wt, message) {
    await git(wt.path, ['add', '-A']);
    const changed = (await git(wt.path, ['diff', '--cached', '--name-only', wt.base])).out.split('\n').filter(Boolean);
    const staged = (await git(wt.path, ['diff', '--cached', '--name-only'])).out;
    if (staged) await git(wt.path, [...this.identity, 'commit', '-q', '-m', message]);
    return changed;
  }

  // 統合ブランチへのマージは 1 本ずつ直列に行う
  merge(branch, message) {
    const job = this.mergeChain.then(async () => {
      const r = await git(this.mainPath, [...this.identity, 'merge', '--no-ff', '-q', '-m', message, branch], { allowFail: true });
      if (!r.ok) {
        await git(this.mainPath, ['merge', '--abort'], { allowFail: true });
        throw new Error(`マージ競合: ${r.err || r.out}`.slice(0, 500));
      }
      this.headSha = await this.head();
    });
    this.mergeChain = job.catch(() => {});
    return job;
  }

  // 失敗した試行が何をしようとしたか（critic に見せる証拠）。worktree を消す前に取る
  async attemptDiff(wt, maxChars = 6000) {
    await git(wt.path, ['add', '-A'], { allowFail: true });
    const r = await git(wt.path, ['diff', '--cached', wt.base], { allowFail: true });
    return r.out.length > maxChars ? r.out.slice(0, maxChars) + '\n…(省略)' : r.out;
  }

  async removeWorktree(wt) {
    await git(this.root, ['worktree', 'remove', '--force', wt.path], { allowFail: true });
    await git(this.root, ['branch', '-D', wt.branch], { allowFail: true });
  }

  async diff(base, paths, maxChars = 40000) {
    const spec = paths.length ? ['--', ...paths] : [];
    const stat = (await git(this.mainPath, ['diff', '--stat', `${base}..HEAD`, ...spec])).out;
    const patch = (await git(this.mainPath, ['diff', `${base}..HEAD`, ...spec])).out;
    return { stat, patch: patch.length > maxChars ? patch.slice(0, maxChars) + '\n…(省略)' : patch };
  }
}

module.exports = { Repo, covered, git };
