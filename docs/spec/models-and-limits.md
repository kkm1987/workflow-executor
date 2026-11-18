# モデルの割り当てと利用枠

## 既定の割り当て

`workflow.config.json`の`models.request`・`models.change`に工程ごとの既定モデルと推論レベルを置く。現在の既定値は次のとおり。

| 工程 | request | change |
|---|---|---|
| plan / prereview | `claude-opus-5-5` / medium | `claude-opus-5-5` / medium |
| execute | `gpt-6.1-sol` / low | `gpt-6.1-sol` / low |
| review | `gpt-6-luna` / high | `gpt-6-luna` / high |
| acceptance | `gpt-6-luna` / high | `gpt-6-luna` / high |

- モデル名が`claude-`で始まればClaude Code CLI、それ以外はCodex CLIで実行する。
- 推論レベルはCLIごとに検証する（Codex: low〜ultra、Claude: low〜max）。モデル固有の非対応値はCLIのエラーになる。
- 案件ごとの指定は`start`・`start-change`の`--model <工程> <モデル> [推論レベル]`、または停止中の`model <ID> <工程> <モデル> [推論レベル]`で`state.models`に保存し、次の試行から既定値に優先する。
- **executeはCodex専用**。executeの通常モデルにClaudeを指定することと、executeの代替を指定することは拒否する。旧案件の通常モデルがClaudeの場合は`model <ID> execute <Codexのモデル>`で変更する。保存済みのexecuteの代替は選択時に無視する。
- 昇格の計画審査（[permissions.md](permissions.md)）は`escalationReview`で指定したCodexモデルで行う（既定 `gpt-6-luna` / medium、`null`で無効）。

## 代替モデル

execute以外の工程は、`fallbacks.request|change.<工程>`に別CLIのモデルと推論レベルを1組指定できる。通常側と代替が同じCLIになる設定は拒否する。

```json
"fallbacks": {
  "request": { "review": { "model": "claude-opus-5-5", "effort": "medium" } },
  "change": { "review": { "model": "claude-opus-5-5", "effort": "medium" } }
}
```

- 案件指定は既定値に優先して`state.fallbacks`へ保存する。開始時は`--fallback <工程> <モデル> [推論レベル]`を繰り返せる。停止中は`fallback <ID> <工程> <モデル> [推論レベル]`で変更し、`fallback <ID> <工程> --disable`で案件に`null`を保存して既定の代替も無効化する。
- `fallback`は設定だけを変更し、質問や停止状態を保持する。通常側を変更する`model`でも代替との整合性を検証し、不正な操作は保存しない。

## 利用枠による選択

各試行の前に、通常側のCLIの残り利用枠を取得する。Codexは`account/rateLimits/read`、Claudeは`/usage`を使う。Claudeは`--safe-mode`で利用者の設定・hook・MCP・pluginなどを読み込まず、モデルを呼ばずに取得し、30秒で打ち切る。

工程ごとの閾値（`limits.<工程>`、セッション窓`primary`／週窓`secondary`の残り%）:

| 工程 | primary | secondary |
|---|---|---|
| plan / prereview / execute | 20 | 10 |
| review / acceptance | 10 | 5 |

閾値は計測の根拠がない初期値であり、実績から見直す（[plan/roadmap.md](../plan/roadmap.md)）。

選択の規則:

1. 通常側が閾値以上なら通常側で実行する。通常側が全窓取得不能な場合も通常側で実行する。
2. 通常側が閾値未満の場合だけ、指定済みの代替を確認する。取得できた窓が1つ以上あり、そのすべてが同じ閾値以上なら代替で実行する（閾値一致は可）。
3. 代替未指定・代替不足・代替の全窓取得不能では、モデルを呼ばず`limited`で停止する。
4. 実行中に上限へ到達した場合は途中の記録を保存して`limited`で止まる。自動切替・自動再試行はしない。

- 取得失敗は候補別の`selection.normal`／`selection.fallback`の`rateLimitsFailure`に、`reason`（`timeout`・`exit`・`spawn`・`parse`）、`elapsedMs`、最大200文字の`detail`を保存する。選択イベントにも残し、`limited`の停止理由と利用枠欄に候補・理由・秒数を表示する。
- 枠はCLI単位であり、モデル固有の残枠を保証しない。

## 代替実行時の扱い

- 選択した代替CLIの起動・認証・必要なアクセス確認に失敗した場合は、モデルを起動せず`failed`で止まる。未選択の代替CLIは必須確認に含めない。
- 承認・許可・工程の編集制限は切替後も維持する。
- 担当が変われば、要求・回答・承認・証拠を含む完全入力を使う。同じ担当で再開条件を満たす回答後はセッションを再開する。
- 候補別の枠と選択理由はイベント・`status`・ダッシュボード、実際の担当は試行履歴・`invocation.json`・`metrics.json`で確認できる。
