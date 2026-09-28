// エージェントの型（kind）。型は「最初に持たせる道具の既定値」で、壁ではない。
//
// 権限は 3 層:
//   ① 共通の安全柵（GUARD）… 型に関係なく禁止。必要なら人間への依頼を通す
//   ② 型の既定値           … 役割の指示・ツール・runner・梯子の下限・検証の方法（kinds/*.md）
//   ③ その場の拡張         … 権限で拒否された操作のうち ① に触れないものは、次の試行で許可する
//
// 型の定義は Markdown（先頭に key: value の frontmatter、本文が役割の指示）。読み込み順:
//   1. このリポジトリの kinds/（組み込み）
//   2. 対象 repo の .atv-kinds/（プロジェクト固有。同名なら上書き）
//   3. root が計画中に作った型（.atv/<runId>/kinds/。① を広げない範囲でだけ自動で作る）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BUILTIN_DIR = path.resolve(__dirname, '..', 'kinds');
const VERIFY = ['check', 'review', 'artifacts'];
const RUNNERS = ['any', 'claude', 'codex'];

// ① 共通の安全柵。claude には --disallowedTools で渡し、全 worker の指示にも書く
const GUARD = {
  claudeDisallowed: [
    'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(sudo:*)', 'Bash(su:*)',
    'Bash(brew install:*)', 'Bash(apt:*)', 'Bash(apt-get:*)', 'Bash(npm publish:*)', 'Bash(gh:*)', 'Bash(docker push:*)',
  ],
  text: 'Never: push or change git remotes, use sudo / system package managers (apt, brew install), publish packages, call paid external APIs, or read or print secrets. ssh/scp to machines named in the goal is allowed. If the task needs any of these, ask the human via humanRequests instead.',
};

// ③ で自動では広げないコマンド（壊す・外と通信する・プロセスを止める）。必要なら人間への依頼を通す
const NO_AUTO_GRANT = ['rm', 'rmdir', 'mv', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'shutdown', 'reboot', 'mkfs', 'curl', 'wget', 'nc', 'env', 'eval', 'exec', 'xargs', 'find'];

// ① に当たる Bash コマンドか（③ の自動拡張で許可してはいけないもの）
function guarded(command) {
  const c = String(command || '').trim();
  return GUARD.claudeDisallowed.some((p) => {
    const m = p.match(/^Bash\((.+):\*\)$/);
    return m && (c === m[1] || c.startsWith(m[1] + ' '));
  });
}

function parse(text, origin, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: frontmatter (---) がない`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*?)\s*(#.*)?$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return normalize({ ...meta, instructions: m[2].trim() }, origin);
}

const list = (s) => (Array.isArray(s) ? s : String(s || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

function normalize(k, origin) {
  const name = String(k.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!name) throw new Error('型に name がない');
  return {
    name,
    description: String(k.description || '').trim(),
    runner: RUNNERS.includes(k.runner) ? k.runner : 'any',
    floor: Math.max(0, Number(k.floor) || 0),
    tools: list(k.tools),
    verify: VERIFY.includes(k.verify) ? k.verify : 'check',
    artifacts: list(k.artifacts).map((x) => x.replace(/^\./, '').toLowerCase()),
    requires: list(k.requires),
    instructions: String(k.instructions || '').trim(),
    origin,
  };
}

function loadDir(dir, origin) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const file = path.join(dir, f);
    return parse(fs.readFileSync(file, 'utf8'), origin, file);
  });
}

const hasCommand = (cmd) => {
  try { execFileSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' }); return true; } catch { return false; }
};

function serialize(k) {
  const lines = [`name: ${k.name}`, `description: ${k.description}`, `runner: ${k.runner}`, `floor: ${k.floor}`,
    `tools: ${k.tools.join(', ')}`, `verify: ${k.verify}`, `artifacts: ${k.artifacts.join(', ')}`, `requires: ${k.requires.join(', ')}`];
  return `---\n${lines.join('\n')}\n---\n${k.instructions}\n`;
}

class Kinds {
  // available: { claude: bool, codex: bool }（runner が使えるか）
  constructor({ repoRoot, runDir, available }) {
    this.available = available;
    this.runDir = runDir;
    this.map = new Map();
    for (const k of [...loadDir(BUILTIN_DIR, 'builtin'), ...loadDir(path.join(repoRoot, '.atv-kinds'), 'repo'), ...loadDir(path.join(runDir, 'kinds'), 'run')]) this.map.set(k.name, k);
  }

  get(name) { return this.map.get(name) || this.map.get('coder'); }

  // 足りないもの（runner と requires）。空なら使える
  missing(k) {
    const miss = [];
    if (k.runner !== 'any' && !this.available[k.runner]) miss.push(k.runner);
    for (const c of k.requires) if (!hasCommand(c)) miss.push(c);
    return miss;
  }

  // root が提案した新しい型。① を広げないもの（既存の型を土台にし、ツールは GUARD に触れない）だけ作る
  create(spec) {
    const base = this.map.get(String(spec.basedOn || '').toLowerCase()) || this.map.get('coder');
    const k = normalize({
      ...base, name: spec.name, description: spec.description, instructions: `${base.instructions}\n\n${spec.instructions || ''}`.trim(),
      tools: [...new Set([...base.tools, ...list(spec.tools)])], requires: [...new Set([...base.requires, ...list(spec.requires)])],
      verify: spec.verify || base.verify, artifacts: spec.artifacts?.length ? spec.artifacts : base.artifacts,
    }, 'run');
    const bad = k.tools.filter((t) => GUARD.claudeDisallowed.includes(t) || guarded((t.match(/^Bash\((.+?)(:\*)?\)$/) || [])[1]));
    if (bad.length) return { error: `安全柵に触れるツールを含むため作らない: ${bad.join(', ')}` };
    if (this.map.has(k.name) && this.map.get(k.name).origin !== 'run') return { error: `同名の型 ${k.name} がすでにある` };
    fs.mkdirSync(path.join(this.runDir, 'kinds'), { recursive: true });
    fs.writeFileSync(path.join(this.runDir, 'kinds', `${k.name}.md`), serialize(k));
    this.map.set(k.name, k);
    return { kind: k };
  }

  // 計画用のカタログ（root に見せる）
  catalog() {
    return [...this.map.values()].map((k) => {
      const miss = this.missing(k);
      return `- ${k.name}: ${k.description}${k.runner !== 'any' ? ` [runner: ${k.runner}]` : ''}${miss.length ? ` (UNAVAILABLE here: needs ${miss.join(', ')})` : ''}`;
    }).join('\n');
  }

  // ボードに出す要約
  summary() {
    return Object.fromEntries([...this.map.values()].map((k) => [k.name, {
      description: k.description, runner: k.runner, verify: k.verify, tools: k.tools, requires: k.requires, origin: k.origin, missing: this.missing(k),
    }]));
  }
}

module.exports = { Kinds, GUARD, NO_AUTO_GRANT, guarded, hasCommand };
