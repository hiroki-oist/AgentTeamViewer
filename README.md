# Agent Team Viewer

プロジェクトを 1 つ渡すと、root エージェントが task graph を作り、各 task を「リスクに見合った一番軽いモデル / effort」の worker に割り振って進める閉ループのオーケストレータと、その進行をリアルタイムで見るボード。

- 失敗したら梯子を 1 段上げて再試行（adaptive inference budgeting）。最初から重いモデルは使わない
- 同じ task が 2 回失敗したら **critic（批判的レビュー）** を立て、詰まっている根本原因・誤った前提・同じやり方の繰り返し・分析の浅さを疑わせる。その診断と指示を次の worker に渡す
- 各 task には **型**（coder / tester / writer / researcher / blender / illustrator …）が付き、型ごとに役割の指示・道具・使うモデル・検証の方法が変わる。足りない型は root が作る
- 各 task は git worktree で隔離し、宣言した `writeSet` の排他ロック・検証コマンド・レビューを通ったものだけを統合ブランチにマージ
- エージェントが自力で解決できないこと（アプリのインストール、認証、権限、判断）は **「あなたへの依頼」** にまとまり、ボードから返答すると止まっていた task が返答つきで再開する

## 使い方

いちばん楽なのは、対象 repo で Claude Code を立ち上げて「このプロジェクトのオーケストレーションを立てて」と頼むこと。skill `atv-orchestrate` が、目標・完了条件・検証コマンド・予算を一問ずつ相談して決め、計画を一緒に確認してから実行させる。起動後も同じ Claude に「進捗は？」「依頼に返答して」と頼める。

```bash
sh skill/install.sh   # atv コマンド（~/.local/bin）と skill（~/.claude/skills）をシンボリックリンクで入れる
```

直接起動する場合:

```bash
# 本番（Claude Code の seat を使う）
atv --repo ../my-project --goal "LIBERO-CTRL を実装して baseline 3 種を動かし、README に結果表を書く"
# → http://127.0.0.1:8000/ を開く

# 検証コマンドと予算を指定
atv --repo ../my-project --goal-file goal.md --check "pytest -q" --budget-usd 20

# 梯子は既定で auto（Codex がログイン済みなら Claude と混ぜる）。固定するなら
atv --repo ../my-project --goal "..." --ladder claude   # codex / mixed も可

# CLI を呼ばずに閉ループ全体を試す（トークン消費なし。git 操作は本物）
atv --repo /tmp/sandbox-repo --goal "試し" --ladder mock
```

### 他の端末から見る（Tailscale）

`--tailscale` を付けると、`tailscale serve` でボードを tailnet 内だけに公開する（例: `http://<machine>.<tailnet>.ts.net:8000/`）。インターネットには出さない。URL はボードのヘッダーと `.atv/<runId>/server.json` の `tailnetUrl` に出て、終了時に公開を解除する。

- tailnet で HTTPS 証明書が有効なら https、なければ http で公開する（どちらも WireGuard で暗号化される）
- CLI は macOS アプリ同梱のもの → PATH の `tailscale` → root なしの userspace 版（`~/tailscale-user/`）の順に探す。別の場所なら `ATV_TAILSCALE_BIN`（と `ATV_TAILSCALE_SOCKET`）で指定する
- ボードには認証がない。tailnet に他人の端末があると、その人も一時停止や依頼への返答ができる

### 元の作業ツリーを守る（保護パス）

エージェントは task ごとの worktree（`.atv/<runId>/tasks/…`）で作業する。元の作業ツリー（と `--protect` で足したディレクトリ）には書かせない。指示文だけに頼らず、次の 2 段で塞ぐ。

- **防ぐ（bwrap）**: bwrap が使えれば、エージェントを「保護パスは読み取り専用、自分の worktree と `.git` だけ書ける」マウント名前空間で動かす。Bash 経由（python・リダイレクト）の書き込みもカーネルが止める。ssh やネットワークはそのまま使える
- **見つける（常に）**: 保護パスのうち git 作業ツリーのものを 5 秒ごとに `git status` で見張る。起動時からの変化を見つけたら新規 spawn を止め（status `protect-hold`）、その時動いていた task を添えて依頼を出す。自動では消さない。確かめたらボードの「保護パスを確認した」（`{"action":"protect-ok"}`）で、今の状態を新しい基準にして再開する。run 中にあなた自身が元の作業ツリーを編集しても止まるので、そのときも同じボタンで再開する

Ubuntu 24.04 以降は AppArmor が非特権の user namespace を止めるため、そのままでは bwrap が動かず「見つける」だけになる（起動ログに出る）。bwrap を許すには一度だけ次を実行する:

```bash
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'P'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
P
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

`index.html` を直接開くか、サーバーなしで配信した場合は、ダミーデータのデモモードで動く（`?autoplay` でシミュレーション自動開始）。

作業は対象 repo の `.atv/<runId>/` 以下の worktree で行い、元の作業ツリーには触れない（`.atv/` は `.git/info/exclude` に追加される）。完了したら統合ブランチ `atv/<runId>/main` を確認してから自分でマージする。

```bash
git log --graph atv/<runId>/main       # 何がマージされたか
git merge atv/<runId>/main             # 取り込む
git worktree remove .atv/<runId>/main  # 片付け
```

依存は Node.js 20+ と `git`、使う runner に応じて `claude` / `codex` CLI のみ（npm install 不要）。

## 閉ループ

```
goal ─▶ root が計画（読み取り専用。epic / task / writeSet / risk / 検証コマンド）
          │
          ▼
   依存が解けた epic から、ロックが取れた task を並列起動（同時数・予算の範囲で）
          │   route = 梯子[リスクから決めた段 + 失敗回数]
          ▼
   worker が task 用 worktree で作業 ─▶ blocked? ─▶ 依頼パネルへ（返答で再開）
          │
          ▼
   検証: writeSet 外の変更なし / 変更あり / 検証コマンドが通る ─NG─▶ 1 段昇格して再試行（上限で人間判断）
          │OK                                      │ 2 回目以降の失敗
          │                                        ▼
          │                              critic が失敗の証拠と差分を批判的に検証
          │                                → やり方を変える指示 / task を定義し直す / 人間に依頼
          │OK
          ▼
   統合ブランチにマージ ─▶ epic の task が揃ったらレビュー ─reject─▶ 修正 task を追加して再実行
          │accept
          ▼
        完了
```

トークンを無駄にしないための仕組み:

- 梯子の下から始める（例: 低リスクの task は haiku/low）。昇格は失敗の証拠が出たときだけ
- 計画とレビューだけ梯子の上から 2 段目（判断の要所だけ重いモデルにする）
- worker に渡すのは自分の task と、完了 task の 1 行要約だけ
- 前回失敗の証拠（検証コマンドの出力末尾など）を次の試行に渡し、同じ失敗を繰り返させない
- 重いモデルに上げるだけで直らないときは、critic がやり方そのものを変えさせる（`--critic-after N`、0 で無効）
- 監視役が予算の 90% で新規 spawn を止める。claude には 1 回あたりの上限 `--max-budget-usd` も渡す
- プランの利用枠（5 時間枠・週の枠）も見る。claude の stream-json が返す `rate_limit_event` の使用率をボードに出し、週の枠が `--plan-week-stop`（既定 90%）か 5 時間枠が `--plan-5h-stop`（既定 95%）を超えたら新規 spawn を止め、リセット時刻に自動で再開する。`--plan-week-share 0.3` のように、この run が週の枠を何ポイント使ってよいかも決められる。エージェントが動いていない間は `--plan-probe-min` 分ごとに haiku を 1 回呼んで確かめる。止まったときはボードの「枠を無視して続ける」（`{"action":"unhold"}`）で、その枠のリセットまで止めずに続けられる

## エージェントの型

型は「最初に持たせる道具の既定値」で、壁ではない。権限は 3 層に分けている。

| 層 | 中身 |
|---|---|
| ① 共通の安全柵 | push・git remote・sudo・apt / brew install・publish・gh は型に関係なく禁止（claude には `--disallowedTools`）。必要なら「あなたへの依頼」を通す。ssh / scp は許可（goal に書いた計算機へジョブを投げるため） |
| ② 型の既定値 | 役割の指示、追加のツール、runner（`any` / `claude` / `codex`）、梯子の最低段、検証の方法、必要なコマンド |
| ③ その場の拡張 | 権限で拒否された操作のうち ① に触れず、壊す・外と通信する系（rm, mv, curl, wget など）でもないものは、次の試行で自動で許可する |

組み込みの型（`kinds/*.md`）:

| 型 | 用途 | 検証 |
|---|---|---|
| coder | 実装・修正（既定） | 検証コマンド |
| tester | テストを書いて壊しにいく | 検証コマンド |
| writer | README・論文の節・設計メモ | レビューで読む |
| researcher | 原因調査・分析。仮説と証拠を分けて報告 | レビューで読む |
| blender | Blender を headless で使う 3D。プレビュー PNG を必ず出す | 成果物の存在 + レビューで画像を見る |
| illustrator | Codex の画像生成で画像素材を作る（runner: codex） | 成果物の存在 + レビューで画像を見る |

- 対象 repo に `.atv-kinds/<名前>.md` を置くと、プロジェクト固有の型を足したり、組み込みの型を上書きしたりできる（書式は `kinds/*.md` と同じ）
- root は計画中に新しい型を提案できる。既存の型を土台にし、① に触れないものだけ自動で作り、`.atv/<runId>/kinds/` に保存する。① に触れる型は作らず、依頼に回す
- 型に必要なもの（Codex、`blender` など）がない環境では、その型の task を止めて「用意してほしい」という依頼を 1 件にまとめて出す
- critic は、型の選び間違いが失敗の原因だと判断したら、別の型に切り替えられる

## ボード

1 画面に固定し、各パネルの中だけスクロールする（幅 1000px 未満では縦に積む）。

| 場所 | 内容 |
|---|---|
| 上段左 | 目標・達成条件・進捗・「いま何をしているか」の 1 行・一時停止 / 再開 |
| 上段右 | 監視役: トークン / コスト / 同時稼働 / 枯渇予測 / 消費速度 / アラート |
| 中段 | かんばん（未着手・実行中・レビュー中・完了）。実行中の task には直近の操作（ツール呼び出し）が出る。カードをクリックすると詳細（説明・要約・試行履歴・失敗の証拠・再試行 / 承認ボタン） |
| 中段右 | あなたへの依頼。ブロッキングのものが上。返答して「対応済み」か「却下」 |
| 下段 | ファイルロックとイベントログ |

## 構成

| ファイル | 役割 |
|---|---|
| `orchestrator/cli.js` | 入口（`atv` コマンド）。オプションの解釈、サーバーとオーケストレータの起動 |
| `skill/atv-orchestrate/SKILL.md` | 対象 repo の Claude Code 用 skill。相談 → 起動 → 計画確認 → 運用 |
| `orchestrator/orchestrator.js` | 閉ループ本体（計画 / スケジューラ / 試行 / 検証 / マージ / レビュー / 依頼） |
| `orchestrator/runners.js` | `claude -p` / `codex exec` / mock のアダプタ。進行中のトークンと操作をストリームで拾う |
| `orchestrator/kinds.js` | 型の読み込み・新しい型の作成・安全柵 |
| `kinds/*.md` | 組み込みの型の定義 |
| `orchestrator/prompts.js` | 各役割（root / worker / critic / reviewer）への指示と構造化出力の JSON Schema |
| `orchestrator/git.js` | 統合ブランチと task ごとの worktree、直列マージ |
| `orchestrator/server.js` | ボードの配信、`/api/events`（SSE）でのリアルタイム更新、操作 API |
| `js/policy.js` | 梯子とルーティング（ボードのデモと共用） |
| `js/locks.js` | writeSet の排他ロック（`dir/` は配下すべて、all-or-nothing） |
| `js/watchdog.js` | 監視役の判定（予算・消費速度・同時稼働数・リトライ・ロック違反・依頼） |
| `js/app.js` | 描画。ライブ接続できなければデモのシミュレーション |
| `js/dummy-state.js` | デモ用の状態。オーケストレータが出す状態 JSON と同じ形 |

## 注意

- worker（claude）は既定で `--permission-mode acceptEdits --allowedTools Bash` で動く。つまり worktree 内の編集と任意のシェルコマンドを確認なしで実行する。絞るなら `--worker-tools "Bash(python3:*),Bash(pytest:*)"`、全部許すなら `--claude-permission-mode bypassPermissions`。headless では `auto` モードは使えなかった（書き込みも拒否される）
- codex の worker は `-s workspace-write`。codex exec はコストを返さないので、codex 分はトークンだけで予算管理する
- 検証コマンドは新しい worktree で走るため、`.gitignore` されているもの（`node_modules`、データ、`.env`）はそこにない。必要なら検証コマンドの中で用意するか、絶対パスで参照させる
- サーバーは 127.0.0.1 のみ・認証なし
- 未実装: 中断した run の再開（状態は `.atv/<runId>/state.json` に保存しているが、読み戻しはまだない）、失敗が続いた task を root が分割し直す再計画
