# 運用と復旧の手順

仕様は[spec/](spec/)を参照。ここでは人が行う操作手順をまとめる。

## skillの登録

skillは実行器との相対位置を使うため、コピーではなく元フォルダーへのリンクで登録する。CodexでもClaude Codeでも同じ実行器を操作する。

```powershell
.\scripts\register-skill.ps1
```

- 既定でCodexとClaude Codeの両方のユーザー用skillディレクトリにリンクする。`-Client codex`または`-Client claude`で登録先を選べる。既存の同名skillは上書きしない。
- 実行器を移動したら登録先のリンクを見直す。

## 実行器の更新

- 実行器を起動する環境には、既存の`data`への書き込み権限が必要。
- 新旧の実行器の混在を避けるため、切替前に全実行器・子プロセス・公開者を停止し、同じ実行器を使う全チャットを更新する。旧`data/executor.lock`が残る間は更新操作を拒否する。
- 既存の状態・回答・承認・証拠・試行は移行せず再利用する。
- ロールバック時も、全新プロセスと子・公開者を停止し、差分と残存予約を整理してから旧版へ戻す。

## 並行編集と一時領域

- 実行前レビュー中、エージェントに書き込みを許可したchangeディレクトリを同時に編集すると、所有者とエージェントの変更を区別できない。
- 案件の一時領域は完了・終了時に削除する。残った一時領域や共有キャッシュの掃除には`node src/cli.js clean [--cache]`を使う。
- 旧版が対象内に作った`htram-worktree6\agent-docs\harden-mgmt-agent-proxy-access-go-cache`は、所有者が手動で削除する。

## 中断後の予約とロックの復旧

- 共有更新ロックへの書き込み拒否（`open wx`、`EPERM`）が出たら、エラーに示された`data`への書き込み権限を起動環境に付与し、同じ`data`で再実行する。
- Codexデスクトップで実行器のスレッドを開くと、書き込みロックを取得する。ロックで再開が拒否された場合は履歴を引き継ぐforkで続け、試行の`invocation.json`に元のIDを`forkedFrom`として残す。forkに失敗した場合は新しいコンテキストで再試行する。
- 強制終了後は次を確認する。
  - `data/reservations/<所有者トークン>.json`（ID・PID・開始時刻・対象群）
  - `data/shared-update.lock`（PID・所有者トークン・開始時刻）
  - 旧`data/executor.lock`
- 壊れた記録や解決できない対象も無視せず停止する。経過時間やPID不在だけでは削除しない。所有者とその子プロセスの終了、対象の差分を確認し、該当ファイルだけを手動で削除する。他の所有者の予約と生存中のロックは削除しない。
- `running`のまま残った案件は、変更を確認した後に`retry <ID>`で復旧する。

## 実行前確認の失敗

- `data/<ID>/preflight-*.json`で失敗した確認項目を見る。
- Windowsで`registered Core`の失敗が出た場合は、実行器が更新済みか、起動したCodexのパス・版、実行前確認の固定の原因文、sandboxログのrunner経路（`using copied command-runner`）を確認する。生の診断は実行前確認の記録へ保存しない。
- elevatedの初期セットアップ・ACL・管理ポリシーの不備は端末管理者が復旧する。実行器は自動昇格しない。

## MXC時代の停止中案件の移行

2026-10-29以前（WindowsでMXCを使っていた版）に停止した案件を現行版で再開する手順。背景は[history/legacy-spec.md](history/legacy-spec.md)。

1. 実行器と子プロセスの停止、対象の途中の差分を確認する。
2. `failed`／中断済み`running`／`limited`は`retry <ID>`で旧セッションを破棄する。
3. `waiting`／`ready`は`status`で現在の工程・有効なモデル・推論レベルを確認し、`model <ID> <現在の工程> <同じモデル> [同じ推論レベル]`で同値を再設定する。同値でも当該工程のセッションを破棄し、質問・許可要求・承認待ちは保持する。
4. 必要な`answer`／`grant`／`approve`の後、`run`で実行前確認をやり直す。

状態JSONや完了済み履歴は直接変更しない。移行前に通常ホストの隔離fixtureで、起動・権限境界・編集ツールとシェルの書き込み・回答後のresumeを実測して成功を確認する。失敗時は運用を停止して原因を復旧する。限定した実測の成功は長期安定性を保証しない。

## executeの判断者の切り替え

停止中に`workflow.config.json`のトップレベル`executeApprovalReviewer`を`"executor"`（従来の3層）または`"auto-review"`（既定）に変更する。仕様は[spec/permissions.md](spec/permissions.md)。

## ダッシュボードをArtifactで公開する

1. claude.aiにログイン済みのClaude Code CLIを用意する。APIキー認証ではArtifactを公開できない。
2. `CLAUDE_CODE_ARTIFACT=1`を指定し、Claudeに`docs/dashboard-artifact.html`を編集せず、capabilitiesなしのplain pageとして非共有で公開するよう依頼する。`-p`を使う場合は`--tools Artifact,Read --allowedTools Artifact,Read --permission-mode dontAsk`を指定する。共有メニューは変更しない。
3. 発行されたURLを`workflow.config.local.json`の`dashboardArtifact.url`に設定する（[spec/dashboard-artifact.md](spec/dashboard-artifact.md#設定)）。
4. 公開先は所有者のアカウントでログインして開く。

通信・利用枠・CLIの機能変更で公開できない場合は、認証とネットワークを確認し、次の保存または`status`で再試行する。
