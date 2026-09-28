---
name: atv-orchestrate
description: いま開いている repo で、Agent Team Viewer のオーケストレータ（自律エージェントチームの閉ループ）を立ち上げて運用する。目標・完了条件・検証コマンド・予算をユーザーと一問ずつ相談して決め、計画を一緒に確認してから実行させる。起動後の進捗確認、エージェントからの依頼への返答、一時停止・再開・停止もこれで行う。「このプロジェクトのオーケストレーションを立てて」「エージェントチームで進めて」「ATV で回して」「オーケストレータの進捗は？」「依頼に返答して」と言われたときに使う。
---

# ATV オーケストレーションの立ち上げと運用

ユーザーと相談しながら目標と検証方法を固め、オーケストレータ（`atv` コマンド）を起動する。起動したら、計画をユーザーと確認してから実行を再開し、その後の運用も手伝う。

オーケストレータの本体と README は `atv` の実体があるディレクトリにある（`readlink -f "$(command -v atv)"` の 2 つ上）。細かい挙動に迷ったら、その README を読む。

**すでに run が動いている場合**（`.atv/*/server.json` があり、その pid が生きている）は、立ち上げには進まない。「運用」の節から始める。

## 1. 下調べ（聞く前に自分で調べる）

調べれば分かることはユーザーに聞かない。次を確認する。

- `git rev-parse --show-toplevel` と `git status --short`。git repo でなければここで止め、`git init` と最初のコミットが必要だと伝える。未コミットの変更があれば「統合ブランチは HEAD から切るので、未コミット分はエージェントに見えない」と伝え、先にコミットするかを聞く
- README、CLAUDE.md、ディレクトリ構成、最近の `git log --oneline -15`
- 検証コマンドの候補: `package.json` の scripts、`pyproject.toml` / `setup.cfg` / `pytest.ini`、`Makefile`、`.github/workflows/*.yml`、`tests/` の有無
- `command -v atv claude codex` で使える runner。`atv` がなければ、Agent Team Viewer の `skill/install.sh` を実行する必要があると伝えて止める

## 2. 相談（一度に一問ずつ）

一問ずつ聞き、ユーザーの答えを受けてから次に進む。下調べの結果から具体的な案を出し、「はい / 修正」で答えられる形にする。選択肢で答えられる問いは AskUserQuestion を使う（推奨案を先頭にし、「(推奨)」を付ける）。

1. **目標**: 何を達成したいか。ユーザーの言葉を受けて、エージェントが誤解しない具体的な 2〜4 文に言い直し、それでよいか確認する
2. **完了条件**: 測定できる条件を 2〜4 個提案する（例: 「`pytest -q` が全部通る」「`results/act.csv` に seed×3 の成功率がある」）
3. **範囲外・制約**: 触ってほしくないファイルやディレクトリ、足してほしくない依存、守るべき API や規約。「特になし」でもよい
4. **検証コマンド**: 各 task の後に新しい worktree で走らせる 1 行のコマンド。候補を出し、合意したら**その場で一度実行して、今の状態で通るか（または期待どおりに落ちるか）と所要時間を確かめる**。worktree には `.gitignore` 対象（`node_modules`、`.venv`、データ、`.env`）がないので、それらに依存するなら、コマンドの中で用意するか絶対パスで参照する形に直す。速いテストがないなら「なし」でもよい（その場合はレビューが唯一の検証になると伝える）
5. **予算と進め方**: 次の既定値を示し、変えたいところだけ聞く
   - `--budget-usd 30` / `--budget-tokens 3000000`（90% で新規 spawn を停止）
   - プランの利用枠: `--plan-week-stop 0.9` / `--plan-5h-stop 0.95`（超えたら止めてリセット時刻に自動再開）、`--plan-week-share 0`（この run が週の枠を使ってよいポイント。0 で無効）。相談の前に `claude -p "ok" --model haiku --output-format stream-json --verbose` の `rate_limit_event` で今の使用率とリセット時刻を測って見せ、それを元に決める
   - `--per-call-usd 5`（claude 1 回あたりの上限）
   - `--ladder auto`（既定。Codex がログイン済みなら Claude と混ぜる。画像生成の型 illustrator は Codex が要る）
   - `--max-agents 4`、`--max-attempts 4`、`--max-tasks 20`
   - `--critic-after 2`（2 回失敗した task に critic を立てて、原因と進め方を批判的に検証させる。0 で無効）
6. **他の端末から見るか**: `tailscale status` が通る環境なら「ボードを tailnet 内の他の端末（別の PC やスマホ）からも見られるようにするか」を聞く。はいなら `--tailscale` を付ける（tailnet 内だけに公開し、インターネットには出さない。ボードには認証がないので、tailnet に他人の端末があるなら、その人も操作できることを伝える）
7. **worker の権限**: 既定は「worktree 内の編集 + Bash 全部を確認なしで実行」。コマンドを絞る案（例: `--worker-tools "Bash(python3:*),Bash(pytest:*),Bash(git status:*),Bash(git diff:*)"`）も示して選んでもらう

## 3. goal ファイルと最終確認

合意した内容を `.atv/goals/<runId>.md` に書く。runId は `YYYYMMDD-HHMM-<英小文字の短い slug>`（ブランチ名に使うので、英数字とハイフンだけにする）。

```markdown
# 目標
<合意した目標>

## 完了条件
- ...

## 範囲外・制約
- ...

## 背景（エージェント向けの補足）
<下調べで分かった、計画に効く事実: 主要ディレクトリ、既存のテスト、使っている FW など。5 行程度まで>
```

起動するコマンドを全部見せ、実行してよいか確認してから次に進む。

## 4. 起動（計画だけ立てて一時停止）

この会話が終わってもオーケストレータが動き続けるよう、`nohup` でプロセスを切り離して起動する。

```bash
ROOT=$(git rev-parse --show-toplevel); RUN=<runId>
mkdir -p "$ROOT/.atv/$RUN"
nohup atv --repo "$ROOT" --goal-file "$ROOT/.atv/goals/$RUN.md" --run-id "$RUN" --paused \
  --check "<検証コマンド>" <合意したオプション> > "$ROOT/.atv/$RUN/orchestrator.log" 2>&1 &
```

`.atv/$RUN/server.json`（`url` / `port` / `pid` / `tailnetUrl`）が出るまで待ち、ボードの URL をユーザーに伝える。`--tailscale` を付けたのに `tailnetUrl` が null なら、ログの「tailnet への公開に失敗」の行と、依頼パネルに出た内容を伝える（Serve が tailnet で無効なら、有効化用の URL が出ている）。

続いて、計画ができるのを待つ。`curl -s <url>api/state` の `run.status` が `paused` か `failed` になるまで、Monitor などで 10 秒おきに確認する（計画には数分かかることがある）。`failed` になったら、ログの末尾を見せて原因を説明する。

## 5. 計画をユーザーと確認する

`api/state` から計画を要約して見せる。

- 中プロジェクトごとに、依存関係、task の一覧（id、**型**（`kind`）、タイトル、writeSet、リスクから決まる初期のモデル / effort）
- root が新しく作った型（`state.kinds` の `origin: "run"`）があれば、その説明と道具。作らなかった型は依頼に出ている
- 型に必要なものが足りずに止まっている task（`status: "blocked"`）と、その依頼
- root が提案した完了条件と、検証コマンド（`run.checkCommand`）
- `requests` にすでに依頼があれば、それも見せる

そのうえで、次のどれにするか聞く（AskUserQuestion）。

- **この計画で実行する** → `curl -s -XPOST <url>api/control -H 'content-type: application/json' -d '{"action":"resume"}'`
- **目標を直して立て直す** → 何を直すか聞き、goal ファイルを更新する。今の run を片付け（下の「停止と片付け」）、新しい runId で 4 からやり直す
- **やめる** → 停止して片付ける

計画の中身そのもの（task の分け方や型の選び方）を直したい場合も「目標を直して立て直す」になる。goal ファイルに「こう分けてほしい」「画像は illustrator で」と書き足すと、root はそれに従う。

run が終わったら、root が作った型（`.atv/<runId>/kinds/*.md`）を、次からも使えるよう対象 repo の `.atv-kinds/` に保存するか聞く（保存はユーザーが了承したときだけ。repo にファイルが増えるため）。

## 6. 運用

ユーザーに聞かれたら、次のように対応する。state は `curl -s <url>api/state` で読む。

- **進捗は？**: `run.status`、完了した task 数、実行中の task とその `activity`、直近の `events` 5 件、`watchdog` の使用量と予算、未対応の `requests` を短くまとめる
- **依頼に答える**: 未対応の依頼（`status: "open"`）を、ブロッキングのものから見せる。インストールや認証のようにユーザー本人の操作が必要なものは、手順を示して、終わったら教えてもらう（秘密情報をチャットに貼らせない）。この repo の中で済むこと（設定ファイルの追記など）は、ユーザーの了承を得てから自分でやってよい。済んだら返答する:
  `curl -s -XPOST <url>api/requests/<id> -H 'content-type: application/json' -d '{"reply":"<返答>"}'`（選択肢のある依頼は `{"option":"<選択肢のラベル>","reply":"<補足>"}`。ユーザーに聞くときは、依頼の選択肢と推奨をそのまま AskUserQuestion の選択肢にする）（対応しないなら `"dismiss": true`）
- **なぜ詰まっているか**: `status: "critique"` の task は critic が検証中。`critiques[]` に critic の結果（`verdict`、`diagnosis`、`flawedAssumptions`、`unansweredQuestions`、`guidance`）があるので、それを要約して伝える。critic の診断に納得できないとユーザーが言ったら、その理由を依頼への返答か goal ファイルの補足として渡す
- **失敗した task**（`status: "failed"`）: その task の `attempts[].note` と `critiques[]` を読んで原因を説明する。再試行させるなら `{"action":"retry","taskId":"<id>"}`
- **差し戻しの上限で止まった epic**（`review.verdict: "needs-human"`）: レビューの note を説明する。ユーザーが承認するなら `{"action":"approve","epicId":"<id>"}`
- **利用枠で止まった**（`run.planHold`、status `plan-limit`）: `watchdog.plan` の使用率とリセット時刻を見せる。リセット時刻に自動で再開する。待たずに続けるとユーザーが決めたら `{"action":"unhold"}`
- **保護パスで止まった**（status `protect-hold`、`run.protectHold`）: 変更されたパスと、その時動いていた task を見せる。エージェントの書き込みなら中身を見て元に戻すか task の worktree へ移すかをユーザーと決め、ユーザー自身の編集ならそのまま。済んだら `{"action":"protect-ok"}`
- **atv を更新した / 様子がおかしい**: `{"action":"restart","mode":"drain"}`（実行中の agent の完了を待つ。急ぐなら `"now"`）で、最新版のコードが同じ設定と状態で立ち上がる。プロセスが落ちていたら `atv --repo <repo> --run-id <runId> --resume`（`nohup` で切り離す。設定は `.atv/<runId>/config.json` から読む）
- **予算で止まった**（`run.frozen`）: 使用量を見せる。ユーザーが広げると決めたら `{"action":"unfreeze"}`（予算が 1.5 倍になる）
- **一時停止 / 再開**: `{"action":"pause"}` / `{"action":"resume"}`
- **完了**（`run.status: "done"`）: 報告書が `.atv/<runId>/report.md` に自動で書かれる（`run.report.path`。途中の分は `{"action":"report"}`）。要点を伝えてから、`git log --graph --oneline <run.branch>` と `git diff HEAD...<run.branch> --stat` を見せ、中身を確認してからマージするよう勧める。マージはユーザーが指示したときだけ行う

## 停止と片付け

```bash
kill <server.json の pid>                         # 実行中のエージェントも中断される。tailnet への公開も解除される
git worktree remove --force .atv/<runId>/main     # 統合ブランチの作業ツリー
git worktree prune
```

統合ブランチ `atv/<runId>/main` を消す（`git branch -D`）のは、中身を捨ててよいとユーザーが言ったときだけにする。
