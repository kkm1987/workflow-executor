# 文書の構成

| 区分 | 文書 | 内容 |
|---|---|---|
| 要求 | [requirements.md](requirements.md) | クライアントの要求と受け入れ条件 |
| 現行仕様 | [spec/workflow.md](spec/workflow.md) | 案件の種類・工程・状態・手戻り・失敗・外部証拠・並行実行 |
| | [spec/models-and-limits.md](spec/models-and-limits.md) | モデルの割り当て・代替・利用枠による選択 |
| | [spec/environment.md](spec/environment.md) | 必要な環境・CLIの起動・Windowsのサンドボックス・実行前確認 |
| | [spec/permissions.md](spec/permissions.md) | 書き込み範囲・昇格の判断・コマンドの許可・承認計画 |
| | [spec/records-and-status.md](spec/records-and-status.md) | 保存ファイル・status・ダッシュボード・性能の記録 |
| | [spec/dashboard-artifact.md](spec/dashboard-artifact.md) | ダッシュボードのclaude.ai Artifact公開 |
| | [spec/cli.md](spec/cli.md) | CLIコマンド一覧 |
| 手順 | [operations.md](operations.md) | skill登録・更新・中断後の復旧・移行・Artifact公開の手順 |
| | [development.md](development.md) | 仕様の管理・テスト・計測 |
| 開発計画 | [plan/roadmap.md](plan/roadmap.md) | 未実現・未確定の項目と評価待ちの事項 |
| | [plan/cross-change-consistency.md](plan/cross-change-consistency.md) | Change横断の整合性レビューの組み込み計画 |
| 記録 | [history/legacy-spec.md](history/legacy-spec.md) | 廃止・変更した仕様と旧状態への影響 |
| | [history/mvp-2026-10.md](history/mvp-2026-10.md) | 初版の方針と検証結果（2026-10） |

## 書き分けの規則

- **spec/** には現在の動作だけを書く。将来の予定や「従来は」の説明は書かない。旧状態の読み込みなど、現行コードが持つ互換動作は仕様として書く。
- **plan/** には未実現・未確定のことだけを書く。実現したらspec/へ移して削除する。
- **history/** には現行でなくなった仕様と過去の検証記録を、記録であると明示して残す。書き換えない（現行との差異の注記を除く）。
- 要件レベルの詳細（シナリオ）はOpenSpecの`openspec/specs/`（ローカル、Git管理外）にある。changeをアーカイブしたら、該当するspec/の文書も更新する。
- skillの手順は[../skills/workflow-executor/SKILL.md](../skills/workflow-executor/SKILL.md)にあり、エージェント向けの指示として仕様と別に保つ。
