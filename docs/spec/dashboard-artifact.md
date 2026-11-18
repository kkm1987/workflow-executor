# ダッシュボードのArtifact公開

表示用の要約`data/dashboard.json`を埋め込んだHTML（[../dashboard-artifact.html](../dashboard-artifact.html)）を、非共有のClaude Artifactへ再公開する。Androidアプリなどで開いたまま更新を読める。閲覧専用で、回答・再開はチャットから行う。

## 要約に含めるもの

要約はローカルパス・ログ参照・外部証拠の本文を除き、工程報告を切り詰める。終了した案件は除外する。**要約はclaude.ai上に保存される。** 案件名・質問・報告などの表示文が外部保存に適することを確認し、Artifactは非共有のまま運用する。

## 設定

URLは`workflow.config.json`と同じディレクトリの`workflow.config.local.json`（Git管理外）に置く。

```json
{
  "dashboardArtifact": {
    "url": "https://claude.ai/artifact/発行されたID",
    "model": "claude-haiku-5-5",
    "timeoutSeconds": 120
  }
}
```

- URL以外は省略でき、上記が既定値。URLは`https://claude.ai/artifact/<ID>`または`https://claude.ai/code/artifact/<ID>`、打ち切りは正の整数秒。
- ローカル設定は`dashboardArtifact`だけを受け付け、同キーがあれば共有設定の`dashboardArtifact`を丸ごと置き換える。共有設定の既存値も有効だが、URLはローカル設定へ移す。
- URL未設定ではClaudeを起動しない。公開を止めるにはローカル設定の`dashboardArtifact`を`{}`にし、既に起動した公開処理の終了を待つ。保存済みのArtifact自体は残る。
- 旧設定の`intervalSeconds`は指定できるが使わない。

初回の公開手順は[operations.md](../operations.md#ダッシュボードをartifactで公開する)を参照。

## 公開のタイミング

- 表示分類・工程・案件の増減・新しい質問など対応事項の変化時と、公開先URLの変更時に公開する。活動・完了タスク数だけの変化や、実行待ちと実行中の切り替わりでは公開しない。
- 状態保存は公開の終了を待たない。公開中の対応事項の変化も終了後に拾う。
- 失敗時は60秒後・300秒後に最大2回再試行する。失敗はワークフローへ伝えない。
- `data/dashboard-publish.json`とMarkdownの末尾に最終成功・新しい失敗を記録する。公開用の一時HTMLは`agent-docs/`に作成して終了時に削除する。
