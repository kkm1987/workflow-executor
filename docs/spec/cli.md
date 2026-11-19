# CLIリファレンス

普段は開発対象のチャットからskillを呼び、要求と回答を普通の文章で伝える。CLIはskillが操作する。手動で使う場合は実行器のルートを作業ディレクトリとして`node src/cli.js <コマンド>`を実行する。要求・回答・条件・理由・証拠のファイルはUTF-8で`agent-docs/`以下に置く。

| コマンド | 説明 |
|---|---|
| `start <対象> <要求ファイル> [--model <工程> <モデル> [推論レベル]]... [--fallback <工程> <モデル> [推論レベル]]...` | 自由記述の要求で開始 |
| `start-change <対象> [change名] [--store <id>] [--model ...]... [--fallback ...]...` | OpenSpec changeで開始。change名を省略すると候補から選定 |
| `run <ID>` | 回答待ち・利用枠不足・失敗・完了まで進める |
| `step <ID>` | 次の1工程だけ実行（調査用） |
| `status [ID \| --all]` | 状態を確認。一覧は終了を除外、`--all`で全件 |
| `status <ID> --detail` | 履歴・回答・外部証拠・昇格履歴を含む詳細 |
| `answer <ID> <回答ファイル> [--inquiry]` | 回答を保存。`--inquiry`は確認の質問 |
| `approve <ID> [--items <ID,...>] [条件ファイル]` | 承認計画の項目を承認 |
| `grant <ID> [--network] [--path <ディレクトリ>]... [--command <コマンド>]...` | 権限要求を許可 |
| `model <ID> <工程> <モデル> [推論レベル]` | 案件の通常モデルを変更 |
| `fallback <ID> <工程> <モデル> [推論レベル]` / `fallback <ID> <工程> --disable` | 案件の代替モデルを変更・無効化 |
| `retry <ID>` | 失敗・中断・利用枠不足の後、変更確認を経て再開可能にする |
| `evidence <ID> <JSONファイル>` | 停止中の案件へ外部証拠を登録 |
| `archive <ID>` | `completed`のchangeを同期・アーカイブ |
| `close <ID> [理由ファイル]` | 実行中以外の案件を終了 |

## 例

```powershell
node src/cli.js start C:\path\to\target agent-docs\request.md
node src/cli.js start-change C:\path\to\target sample-change --model review gpt-6.2-sol high --fallback review claude-opus-5-5 medium
node src/cli.js run <ID>
node src/cli.js status <ID>
node src/cli.js answer <ID> agent-docs\answer.md
node src/cli.js model <ID> execute gpt-6-luna high
node src/cli.js fallback <ID> review --disable
node src/cli.js archive <ID>
```

各コマンドの挙動は[workflow.md](workflow.md)、[models-and-limits.md](models-and-limits.md)、[permissions.md](permissions.md)を参照。
