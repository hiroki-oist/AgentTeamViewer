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

### 点検役（自浄作用）

人がボードで気づくはずのおかしさを、点検役が先に見つけて直す。15 分ごと（`--inspect-min`、0 で無効）と、依頼が出た・task が失敗した直後に動く（3 分に 1 回まで）。

- **一段目**: 梯子のいちばん下（haiku/low）が、ボードの要約を読んで「異常の可能性があるか」だけを判定する。何もなければここで終わる
- **二段目**: 怪しいときだけ、梯子の 4 段目（sonnet/high）が一段目の指摘を手がかりに検査し、許された範囲で直す: 依頼の文面の書き直し、人の対応が要らない依頼への回答（decision / other だけ。install / auth / access / sandbox には答えない）、task の次の試行への注意書き、本当に止まっている task（進み具合が 20 分以上更新されず、平均の 2 倍以上走っている）の中断とやり直し（途中の変更は持ち込む）、見出し・説明の書き直し、あなたへの判断の依頼
- 予算・task の中止・計画の変更は自分では決めない。atv 自体の作りに原因がある問題は `.atv/<runId>/improvements.md` に書き溜める
- 最後の点検の結果は監視パネルの警告欄に出る
### Codex の sandbox で止まったとき

Codex の worker は既定で `--codex-sandbox workspace-write` の中で動き、ネットワークとローカル IPC（パッケージマネージャやライセンスの常駐プロセスへの接続など）が遮断される。worker にはそのことを伝え、それが原因で止まったら kind `sandbox` の依頼を付けて止まるよう指示している（付け忘れても、`EPERM` などの文面から拾う）。

- **どの runner でもよい型**（coder など）: 人間に聞かずに、その task を Claude の梯子で再試行する（途中の変更は持ち込む）。以後この run では、どの runner でもよい型を Claude で動かす。ボードには対応不要の依頼を 1 件だけ出し、Codex を sandbox なしで使いたい場合の手順も書いておく
- **Codex 専用の型**（illustrator など）や `--ladder codex`: Claude に回せないので、ブロッキングの依頼を出す。依頼には、`.atv/<runId>/config.json` の `args` に `"--codex-sandbox", "danger-full-access"` を足してボードの「⟳ 再起動」を押す、という具体的な手順を書く。sandbox を広げるのは人間だけが行う（atv は自分では広げない）

### Codex の利用上限に届いたとき

Codex が利用上限（ワークスペースの spend cap、使用量の上限、rate limit など）で動かなかったときは、失敗に数えない（梯子を上げない・critic を立てない）。その task を止めて、「Codex の利用上限に届いた」というブロッキングの依頼（種類「利用上限」）を 1 件だけ出す。上限の間に止まった Codex の task はすべてこの依頼に足していき、人間が上限を解放して返答すると、まとめて再開する。Codex を使わない task はそのまま進む。

### 作るものの種類ごとの effort

型の frontmatter に `efforts:` を書くと、リスクではなく「作るものの種類」で最初の effort を決める（失敗するたびに 1 段ずつ上げるのは同じ）。組み込みの illustrator は `icon=low`・`ui=medium`・`texture=high`・`hero=high`。種類は task の説明の「画像の種類: <名前>」で指定し、無ければ題名、次に説明の語（括弧の中の語。英字は単語単位）で見分ける。root には、1 つの task に 1 種類だけ入れ、説明に種類を書くよう伝えている。

```
efforts: icon=low(アイコン|icon), texture=high(テクスチャ|texture|地面)
```

### 差し戻しが続いたら上位モデルが引き継ぐ

中プロジェクトのレビューで差し戻しが `--max-review-rounds`（既定 2）に達しても、すぐには人間に回さない。梯子の最上段（claude の梯子なら opus/xhigh）が、その中プロジェクトを 1 つの task（`<epic>-TO<n>`）で丸ごと引き継ぐ。引き継ぐ task には、これまでのレビューの指摘の履歴と最後に求められた修正を全部渡し、なぜ通らなかったのかを見極めてから、必要なら作り方を変えて直すよう指示する。writeSet はその中プロジェクトの全 task と修正の範囲。引き継いだ後のレビューも最上段が行う。引き継ぎは `--takeover-rounds`（既定 2、0 で無効）回まで。それでも通らなければ人間判断待ち（`review.verdict: "needs-human"`）になる。

### 共有の置き場所でロックをぶつけない（--split-dirs）

確認用のスクリーンショット置き場のように、多くの task が「そこに何か置く」だけの場所が writeSet に入ると、ロックがぶつかって task が 1 本ずつしか進まない。`--split-dirs "Docs/Previews/"` のように指定すると、writeSet にその場所そのものがある task は `Docs/Previews/<taskId>/` に置き換える（計画のときも、`--resume` で読み直したときも）。worker にはこの writeSet が伝わるので、自分のサブフォルダに書く。それでも計画の説明に古い置き場所が書いてあって、worker が `Docs/Previews/` の直下に書いてしまったときは、失敗にせず atv が `Docs/Previews/<taskId>/` へ移してからコミットする（前からあったファイルは元の中身に戻す）。

### task が残したプロセスと一時フォルダの後始末

worker の `TMPDIR` を task ごとのフォルダ（`/tmp/atv-<runId のハッシュ 6 桁>-<taskId>/`。長いパスだと Unity のコンパイルが壊れるので短くする）にする。試行が終わったら（自分のジョブの完了待ちのときを除く）、その task の作業ツリー（`.atv/<runId>/tasks/<taskId>-a<n>`）か一時フォルダのパスを引数に持つプロセスを種にして、同じプロセスグループ（頭が居ない孤児のグループだけ）と子孫まで止める。nohup で切り離した Unity の検証などが、試行の後も CPU を使い続けるのを防ぐ。task が完了か失敗で終わったら、その一時フォルダ（Unity の一時コピーなど）も消す。

### 点検役が自分で直す（流れの見張りと学びの共有）

点検役の第一の役目は「作業が流れ続けること」で、人に知らせるより先に自分で原因を取り除く。

- **停滞の検知**: 30 分どの task も完了しないか、仕事が残っているのにエージェントが 15 分 0 本のままなら、点検役を呼ぶ（15 分に 1 回まで）
- **流れの要約**: 点検役に渡す盤面に、最後の完了からの時間、道を塞いでいる task（何本の task が直接・間接に待っているか）、未着手の task が何を待っているか（依存・ロック）、ディスクとメモリの空き、前回の点検の所見を載せる
- **自分でできること**: `add_task`（誰も受け持っていない根本原因を直す task を足し、待つべき task に前提として付ける）、`drop_need`（要らない依存を外す）、`wake_task`（終わったジョブを待っている task を今すぐ起こす）、`share_lesson`（全 task に学びを配る）、`restart_task`（道を塞いでいる task は 15 分止まっていればやり直せる）。`ask_human` は最後の手段
- **学びの共有**: worker は結果に `lessons`（ほかの task も踏みそうな落とし穴と避け方）を書き、点検役も `share_lesson` で足せる。run の間に集まった学びは、以後のすべての worker の指示に載る（同じ内容は重ねない、最大 40 件）
- `improvements.md` に書くのは atv の作りの問題だけで、書いただけでは今の run は直らない。今の run に効くなら、点検役は同時に回避の手を打つ

### ディスクとメモリの見張り

- ディスクの空き（repo と一時フォルダのある場所）が `--disk-min-gb`（既定 20）を下回ったら、新規 spawn を止め（status `disk-hold`）、終わった task の一時フォルダを消し、点検役に原因を探させる。1.5 倍まで戻れば再開
- worker には「一時コピーは必ず `$TMPDIR`（task ごとのフォルダで、task が終われば消える）の下に作る。/tmp 直下や決め打ちのパスに作らない」と共通の安全柵で伝える
- メモリの空きは Linux では /proc/meminfo、macOS では vm_stat（空き + inactive + speculative + purgeable）で測る（以前は macOS で測れておらず、下限が効いていなかった）

### 重いキャッシュを使い回す（--warm-dirs）

Unity の `Library` のように、作り直すと数十分かかるが git の管理外で作り直せるものは、`--warm-dirs "Library"` と指定する。

- run ごとに温まった写し（`/tmp/atv-<runId のハッシュ>-warm/<dir>`）を 1 つ持つ
- task の作業ツリーを作ったときと、検証コマンドを走らせる前に、写しをクローン（macOS は APFS の clonefile、Linux は reflink）で入れる。一瞬で終わり、ディスクもほぼ使わない。クローンできない場所では何もしない（普通のコピーはしない）
- 検証が通ったら、その作業ツリーの `<dir>` を新しい写しとしてクローンで差し替える（rename で一度に入れ替える）。最初の写しは、最初に検証が通った task のもの
- worker には環境変数 `ATV_WARM` と指示で、写しの場所と「別のコピーが要るときは `cp -cR "$ATV_WARM/<dir>"` でクローンし、同じコピーを使い回す。`$ATV_WARM` には書かない」を伝える

### プロジェクト報告書

全部の中プロジェクトが完了すると、root が `.atv/<runId>/report.md` に報告書を書く（ボードの「📄 報告書」で開ける。途中でも「📄 報告書を作る」で、そこまでの分を作れる）。材料は task ごとの意図・各試行の結果・critic の指示・レビューの所見・人間の返答を時刻順に並べた記録と、統合ブランチの結果ファイル。何を、どういう意図でやり、どんな結果が出て、それを受けて次に何をしたかを時系列で淡々と並べる。評価・言い訳・「棄却された仮説」「今後の課題」のような節は書かせない。

### 中断と再起動（設定と状態を引き継ぐ）

- **ボードの「⟳ 再起動」**: 新規 spawn を止め、実行中のエージェントが終わるのを待ってから（または今すぐ中断して）状態を保存し、**最新版のコード**で同じ引数 + `--resume` の新しいプロセスを立ち上げてから抜ける。atv を更新したときや、様子がおかしいときに使う。API は `{"action":"restart","mode":"drain"|"now"}`
- **プロセスが落ちている・止まっているとき**: `atv --repo <repo> --run-id <runId> --resume`。起動時の引数は `.atv/<runId>/config.json` に保存してあり、それを土台に今回の引数で上書きする（例: `--max-agents 6` を足す）。goal ファイルも読み直すので、goal を直してから再開できる
- 再起動・停止で中断された task は失敗に数えず、途中の変更をブランチに残して次の試行に持ち込む（「今すぐ中断」でも作業は捨てない）
- `--resume` は `.atv/<runId>/state.json` から計画・task の状態・依頼・使用量・利用枠の起点を引き継ぎ、統合ブランチもそのまま使う（計画し直さない）。実行中だった task は中断扱いで todo に戻り、レビュー中だった中プロジェクトはレビューし直す

`index.html` を直接開くか、サーバーなしで配信した場合は、ダミーデータのデモモードで動く（`?autoplay` でシミュレーション自動開始）。

依存は task 単位で持てる（計画の `needs`）。task は自分の needs が済めば、上流の中プロジェクトの残りを待たずに始まる。needs がない古い計画を `--resume` で読んだときは、root に依存だけを補わせる（計画は作り直さない）。

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
