## Context

動機はproposal.md - Whyを参照。現状、`save()`（`src/workflow.js`）が状態保存のたびに`dashboard()`を呼び、`data/dashboard.md`を全件から再生成する。実行中は10秒ごとにも保存される。ルートエージェントはCodexで、実行器は工程担当として既にClaude Code CLIを`-p`・`--permission-mode dontAsk`・`--allowedTools`で起動している（`claudeArgs`、`src/executor.js`）。

実測では`CLAUDE_CODE_ARTIFACT=1`で画面なしの`claude -p`にArtifactツールが現れる。DB書き込みは個別許可が必要で`dontAsk`では拒否されたため、当初の代替案であるHTML再公開方式を採用する。同一URLへの非共有ページの再公開は`dontAsk`で成功した。結果は`agent-docs/Artifact公開の実現性検証.md`に記録する。

## Goals / Non-Goals

**Goals:**
- 状態保存の経路に、要約生成と非同期公開の起動を足すだけで実現する
- Claudeには判断をさせず、生成済みHTMLの公開だけを行わせる

**Non-Goals:**
- 閲覧ページからの回答・再開などの操作
- 通知（プッシュ等）、他者への共有、複数の公開先
- `data/dashboard.md`・`status`の表示内容の変更（公開結果の1行追加を除く）
- 実行器を常駐させること。公開は実行器が動いている間の状態保存を契機とする

## Decisions

### 1. 要約は実行器が決定的に生成し、Claudeは転送だけを行う
`dashboard()`内で、既存の`summary(state, base)`の結果から`data/dashboard.json`を生成する。分類・並び順は`dashboard.md`と同じ定義を共有する。
- 代替: Claudeに状態ファイルを読ませて要約させる → トークン費用・ぶれ・情報漏れ（パスや証拠本文）の危険があり不採用。

### 2. 全件の要約を埋め込んだHTMLを同じURLへ再公開する
`{generatedAt, counts, groups:[{label, cases:[...]}]}`をHTMLへ安全に埋め込み、実行器が表示内容を決定する。Claudeは生成済みファイルをArtifactのplain pageとして指定URLへ公開するだけとし、内容を編集させない。毎回全件を置き換えるので、消えた案件が残らない。報告は表示用に切り詰める。DBやruntime capabilitiesは使わない。
- DB案は`file_path`による`set`・`update`・`get`まで検証したが、毎回の書き込み確認が`dontAsk`と両立しないため不採用。許可を応答するホストを製品へ追加せず、検証済みの再公開方式を選ぶ。

### 3. 即時か間引きかは「案件ごとの(状態, 工程)」の変化で決める
公開記録に最後に公開したURL・要約のハッシュと、案件ごとの`(id, status, stage)`の一覧を保存する。公開先URLを変更した場合は内容が同じでも新しい公開先へ転送する。
- 要約のハッシュが同じ → 起動しない
- `(id, status, stage)`の一覧が違う（遷移・工程境界・案件の増減）→ 即時起動
- それ以外 → 前回の起動から間引き間隔（既定300秒）が経過していれば起動
- 遷移を呼び出し元から通知させる案は、`save()`の全呼び出し箇所に手を入れる必要があり不採用。

### 4. 公開処理は切り離したNodeプロセスとし、その中でClaudeを起動する
`dashboard()`は条件を満たすと`node src/publish.js`を`detached`・`stdio: 'ignore'`・`unref()`で起動して戻る。`publish.js`は次を行う。
1. `data/dashboard-publish.lock`を排他作成で取る。取れなければ終了（実行中の公開者が後で拾う）。古いロック（打ち切り時間の2倍超）は奪う。
2. 現在の`dashboard.json`のハッシュを取り、その要約を埋め込んだ公開用HTMLを`agent-docs/`配下の一時ファイルへ生成する。OSの一時領域は使わない。
3. `claude -p`を固定の指示で起動する。`--model`は設定値、`--setting-sources ''`、`--strict-mcp-config`、`--tools`と`--allowedTools`は`Artifact,Read`、`--permission-mode dontAsk`、打ち切り時間（既定120秒）。子プロセスだけに`CLAUDE_CODE_ARTIFACT=1`・`CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0`を渡す。指示は公開先URL・生成済みHTMLのパスと、内容を変更せず非共有のまま再公開する固定文だけを含む。プロセスの終了コードだけでなく、Artifactツールの公開成功結果と対象URLを確認して成功とする。
4. 成否を`data/dashboard-publish.json`に記録する（成功: 時刻・ハッシュ・`(id, status, stage)`一覧、失敗: 時刻・理由）。
5. `dashboard.json`のハッシュが2.と変わっていれば2.へ戻る（最大3回）。ロックを解放後に最新ハッシュを再確認し、まだ未転送の更新があれば次の公開プロセスを起動する。失敗中の更新も同様に拾うが、失敗した同じ要約だけでは再起動を繰り返さない。
- 代替: 実行器の中で非同期に`spawn`して待たない → `run`の終了時に子プロセスの扱いが実行器の寿命に引きずられる。独立プロセスにして実行器の終了と無関係にする。
- 状態ファイルは読まず、ロック（`lock()`）も取らない。

### 5. 設定は`workflow.config.json`の`dashboardArtifact`
`{ "url": "https://claude.ai/...", "model": "claude-haiku-5-5", "intervalSeconds": 300, "timeoutSeconds": 120 }`。`url`がなければ何もしない。`readConfig()`で形式を検証する。

### 6. 閲覧ページは初回公開のURLを継続して更新する
リポジトリに閲覧ページのHTMLを置き、未公開時の表示で非共有のplain pageとして初回公開する。発行されたURLを設定へ書き、以後は要約を埋め込んだHTMLを同じURLへ再公開する。外部スクリプトは使わない。開いたままの表示更新はArtifactビューアーの再公開反映を使い、Android実機で確認してから実装へ進む。

## Risks / Trade-offs

- [Artifactが`-p`で既定無効] → 検証済みの環境変数を子プロセスへ渡す。将来のCLI変更で使えなくなった場合は公開失敗として記録する。
- [公開先はclaude.ai上に要約を置く] → 要約からパス・ログ・証拠本文を除く。公開先は共有しない運用とし、READMEに記す。
- [間引きにより最新活動が最大で間隔分遅れる] → 遷移と工程境界は即時。ページに要約の更新時刻を常に出す。
- [実行器が止まると以後は公開されない] → 実行器の最後の保存（終了時の遷移）は即時起動される。公開中の変化は公開者が拾う。
- [公開のたびにClaudeの利用枠を使う] → 安価なモデル、内容不変なら起動しない、間引き。タスク1で1回の時間と費用を測る。
- [打ち切りで孤立したClaudeプロセス] → 打ち切り時に子プロセスを終了させ、ロックは時間で奪えるようにする。

## Migration Plan

設定`dashboardArtifact.url`を書くまで動作は変わらない。ロールバックは設定の削除。

## Open Questions

- 間引き間隔と打ち切り時間の既定値は、タスク1の測定結果で調整する（仕様・構成は変わらない）。
