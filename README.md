# Workflow Executor

ローカルの開発対象（リポジトリ・worktree）で、自由記述の要求またはOpenSpec changeを、Codex・Claudeのエージェントに工程ごとに別コンテキストで実行させる実行器。普段の開発で使うチャットからskillを呼び出して使う。

- **OpenSpec change**: 選定・実行前レビュー → タスク群ごとの実装・独立レビュー → 最終確認 → 同期・アーカイブ
- **自由記述の要求**: 計画（要求整理・粒度判定・設計判定）→ タスクごとの実装・独立レビュー → 最終確認

エージェントからの質問・権限要求・承認はチャットに提示され、回答後は同じ工程のセッションを再開する。独立レビューを通ったタスクだけが完了扱いになる。自動コミット・公開は行わない。

## 必要なもの

- Node.js 22以上
- 認証済みのCodex CLI（executeは常にCodexで実行する）
- Claudeを割り当てる工程がある場合は、認証済みのClaude Code CLI（既定ではplan・prereviewがClaude）

## セットアップ

```powershell
git clone <リポジトリURL>
cd workflow-executor
npm ci
```

別のリポジトリやworktreeから使うため、ユーザー用skillディレクトリへリンクを登録する（Windows）。

```powershell
.\scripts\register-skill.ps1
```

## 使い方

開発対象を開いたチャットからskillを呼び出す。

- Codex: `$workflow-executor`
- Claude Code: `/workflow-executor`

引数なしで呼ぶと、OpenSpecの次に実行すべきchangeの選定から始める。change名や自由記述の要求を指定して開始することもできる。以降の質問への回答・承認・状態確認もチャットで普通の文章で行い、CLIの操作はskillが行う。

CLIを直接使う場合は、実行器のルートで次のように実行する（[CLIリファレンス](docs/spec/cli.md)）。

```powershell
node src/cli.js start-change C:\path\to\target [change名]
node src/cli.js run <ID>
node src/cli.js status <ID>
```

## 設定

- `workflow.config.json`: 工程ごとの既定モデル・代替モデル・利用枠の閾値・executeの昇格の判断者（[モデルと利用枠](docs/spec/models-and-limits.md)、[権限と承認](docs/spec/permissions.md)）
- `workflow.config.local.json`（Git管理外）: ダッシュボードのArtifact公開先（[Artifact公開](docs/spec/dashboard-artifact.md)）

ワークフローの状態とログは`data/`、要求・回答などの入力ファイルは`agent-docs/`に置く（どちらもGit管理外）。開発対象には保存しない。

## テスト

```powershell
npm test
```

実際のCodexを使う`npm run test:e2e`や計測スクリプトは[開発とテスト](docs/development.md)を参照。

## 文書

- [文書の構成](docs/README.md) — 全文書の一覧と書き分けの規則
- [現行仕様](docs/spec/workflow.md) — 工程・状態・手戻り・失敗の扱い
- [運用と復旧の手順](docs/operations.md) — 中断後の復旧、更新、移行
- [開発計画](docs/plan/roadmap.md) — 未実現・未確定の項目
- [廃止した仕様の記録](docs/history/legacy-spec.md)
