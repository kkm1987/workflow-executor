# 廃止・変更した仕様の記録

> **この文書は過去の仕様の記録であり、現行仕様ではない。** 現行仕様は[../spec/](../spec/)を参照。
>
> 旧状態の案件の読み込み、過去の記録の解釈、切り戻しの判断に必要なものだけを残す。日付は対応するOpenSpec changeのアーカイブ日。

## 一覧

| 時期 | 旧仕様 | 現行 | 旧記録・旧状態への影響 |
|---|---|---|---|
| 〜2026-10-16 | 自由記述の計画を要求整理・粒度判定（`granularity`）・設計判定（`architecture`）の3工程に分けて別コンテキストで実行 | 1つの`plan`コンテキストで順に判断 | 旧工程で停止した案件は、次の実行前確認の後に`plan`へ戻す |
| 〜2026-10-29 | WindowsでMXCを優先するサンドボックス | `features.prefer_mxc=false`・`windows.sandbox=elevated` | 停止中の案件は[移行手順](../operations.md#mxc時代の停止中案件の移行)で再開する |
| 〜2026-10-29 | 実行器全体で1つの`data/executor.lock`による排他（一度に1工程） | 対象ごとの予約と短い共有更新ロックで、独立した案件を並行実行 | 旧`executor.lock`が残る間は更新操作を拒否する |
| 〜2026-10-29 | Artifact公開先を共有設定`workflow.config.json`に置く | Git管理外の`workflow.config.local.json` | 共有設定の値も有効だが、ローカルへ移す |
| 〜2026-10-31 | Markdownのダッシュボードを実行中10秒ごとに更新。Artifactを`intervalSeconds`ごとに公開 | Markdownは工程境界と`status`で再生成。公開は対応事項の変化時だけ | `intervalSeconds`は指定できるが使わない |
| 〜2026-11-01 | Codexを非対話実行（`codex exec`）で起動 | `codex app-server`のstdio JSON-RPC | 通知は従来のexec形式へ変換して`codex.jsonl`に残す |
| 〜2026-11-07 | Codexの再開試行の`usage`にスレッド累計を記録 | 試行で使った分だけを記録し、累計は`threadUsage` | 修正前の再開試行のトークンは過大 |
| 〜2026-11-05 | 承認項目にIDがない | 項目ごとにIDと`gate`を持つ | IDのない旧項目は読み込み時にIDを補い、`gate`がなければ`each` |
| 〜2026-11-15 | 承認の条件は案件全体に付き、承認は全項目一括 | `approve --items`で項目ごとに承認し、条件も項目ごとに持つ | 旧状態の案件全体の条件は全項目に適用 |
| 〜2026-11-05 | コマンドの許可は全文一致だけ | スクリプトを実行するコマンドは許可時の内容（`grants.commandHashes`）に束縛 | ハッシュのない旧許可は有効 |
| 〜2026-11-18 | executeの昇格を実行器の3層の判断（決定的な判定→計画審査→所有者）で判断 | 既定はCodexの自動レビュー | 3層の判断は`"executeApprovalReviewer": "executor"`で引き続き選べる |
| 〜2026-11-18 | executeにClaudeを割り当て可能。代替（既定は`claude-sonnet-5-5`）も指定可能 | executeはCodex専用、代替なし | 下記 |
| 〜2026-10-24 | 通知はダッシュボードと実行ログ | skillを呼んだチャットで状態確認・完了通知 | ― |

## ClaudeによるexecuteとGit Bash（〜2026-11-18）

executeをClaudeで実行していた間の仕組み。2026-11-18のexecute-codex-auto-reviewで削除した（`src/claude-gate.js`、Git Bashの解決と実行前確認）。

- Claudeのexecuteも3層の判断と同じ制約で動いた。`PreToolUse`フックが`Bash`を`codex sandbox`で包み、先頭行が`# workflow-escalate: <理由>`の場合だけ2行目を3層の順に判断した。`Edit`・`Write`は対象・許可パス・changeディレクトリの外と`.git`への書き込みを拒否した。フックが動作しない場合は実行前確認で`failed`にした。
- Windowsでは`CLAUDE_CODE_GIT_BASH_PATH`、`PATH`上の`bash.exe`（System32とWindowsAppsを除く）、`PATH`上の`git.exe`から求めたGitの導入先の`bin\bash.exe`の順にGit Bashを探し、実行前確認でサンドボックス内の起動を確かめた。

現行での扱い: 旧案件の通常モデルがClaudeのexecuteは`model <ID> execute <Codexのモデル>`で変更する。保存済みのexecuteの代替は選択時に無視する。

## 初版の方針（2026-10）

初版の試作方針・受け入れ条件・検証結果は[mvp-2026-10.md](mvp-2026-10.md)に残す。
