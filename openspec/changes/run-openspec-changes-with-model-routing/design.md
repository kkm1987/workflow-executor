## Context

実行器は1工程ずつ`codex exec --ephemeral`を起動し、結果スキーマで応答を受け取り、状態・証拠・計測を`data/<ID>/`に保存する（`src/executor.js`、`src/workflow.js`）。工程は`plan → execute → review → acceptance`の固定で、モデル・推論レベルはCLIの既存設定に任せている。動機はproposal.md、要求はspecs/を参照。

調査で確認した前提（2026-10-24、Windows）:

| 項目 | 確認結果 |
| --- | --- |
| Codex | デスクトップアプリ同梱の`%LOCALAPPDATA%\OpenAI\Codex\bin\<ハッシュ>\codex.exe`（`0.163.0-alpha.11.2`）。`PATH`にはない。ハッシュの異なるフォルダーが複数あり、更新で変わり得る |
| Codexのモデル | `gpt-6-luna`（推論 low〜max）、`gpt-6.1-sol`（low〜ultra） |
| Codexの再開 | `codex exec resume <thread_id>`で`-m`・`--json`・`--output-schema`・`-o`を使える。`--sandbox`はなく`-c sandbox_mode=...`で指定する。`--ephemeral`ではセッションが保存されない。`thread_id`は`--json`の`thread.started`に出る |
| Codexの利用枠 | `codex app-server`へ`account/rateLimits/read`を送ると、`primary`（300分枠）と`secondary`（週枠）の`usedPercent`・`resetsAt`が返る |
| Claude | `claude -p`に`--model`・`--effort`・`--output-format json`・`--json-schema`・`--permission-mode`・`--allowedTools`・`--session-id`・`--resume`がある |
| Claudeの利用枠 | `claude -p "/usage" --output-format json`はモデルを呼ばず（費用0）、`result`に「Current session: N% used」「Current week (all models): N% used」を含む文章を返す。Git Bash経由では`/usage`がパスに変換されるため、引数を直接渡す |
| OpenSpec | 実行器のdevDependencyに`@fission-ai/openspec` 1.10.0。`list --json`、`validate`、`archive -y --json`がある |

## Goals / Non-Goals

**Goals:**
- 既存の状態機械・証拠・計測・ロックを再利用して、changeのワークフローと工程ごとのモデル割り当てを足す。
- 外部ライブラリ・常駐プロセスを増やさない（Node.js標準機能と既存のCLIだけ）。

**Non-Goals:**
- Codexのマルチエージェント機能・Claudeのサブエージェント機能による工程の委譲。親のサンドボックス継承でレビューの読み取り専用を強制できず、ベンダーをまたげず、状態・証拠をルートのモデル任せにするため採用しない。
- 利用枠の消費予測、モデルの自動切り替え、並列実行、ルートセッションのモデル設定の管理（クライアントのCodex設定に任せる）。

## Decisions

### 1. ワークフローの種類と工程

状態に`kind`を持たせる。既存は`request`（`plan → execute → review → acceptance`）、新規は`change`（`prereview → execute → review → acceptance`）。`kind`がない保存済み状態は`request`として読む。

```
start-change <対象> [change名]
   │  候補なし・指定changeなし → 開始拒否（モデル呼び出しなし）
   ▼
prereview ── question ──▶ waiting ──answer──▶ 同じセッションを再開
   │ ok（選定・実行可否・更新の根拠、タスク群）
   ▼
execute(タスク群1) → review ──revise──▶ prereview（未完了分を再定義、手戻り上限3）
   │ ok
   ▼  …タスク群ごとに繰り返す
acceptance（常に実行） ──revise──▶ prereview
   │ ok
   ▼
completed ──(ルートが実行)──▶ archive <ID>
```

`prereview`は既存の`plan`と同じ「計画役」で、差し戻し先にもなる。候補の列挙は実行器が`openspec list --json`（実行器のdevDependencyを開発対象のcwdで起動）でモデルなしに行い、`change`名の指定がなければ未完了の候補一覧を`prereview`へ渡す。選定と実行前レビューを1コンテキストにまとめるのは、前回の計画統合と同じく、起動回数と再読込を減らすため。

`prereview`の応答は専用の結果スキーマにする（`change`、`decisions.selection`・`decisions.applicability`・`decisions.updates`、`tasks`）。既存の`decisions.requirements`等を流用すると意味がずれ、Codexのstrictスキーマでも全項目が必須になるため分ける。

### 2. 実行前レビューの書き込み制限と検証

Claudeを`--permission-mode dontAsk`で起動し、`--allowedTools`で読み取り系、OpenSpecの参照・検証コマンド、`openspec/changes/<change>/`配下への`Edit`・`Write`だけを許可する。許可外の操作は確認なしで拒否される。

モデル任せにしないため、実行器も二重に確かめる。

- 既存の`before.json`・`after.json`の記録を`prereview`にも適用し、変更ファイルが対象changeのディレクトリ外にあれば`failed`にする。
- `ok`の後に実行器が`openspec validate <change>`を実行し、不合格なら`failed`にする。

代替案のCodex（`workspace-write`）では書き込み先をディレクトリ単位で制限できないため採らない。

### 3. 工程の割り当てと設定

工程ごとの割り当ては`{ cli, model, effort }`。CLIはモデル名から決める（`claude-`で始まればClaude、それ以外はCodex）。

| 工程 | 既定値 |
| --- | --- |
| prereview | `claude-opus-5-5` / medium |
| execute | `gpt-6.1-sol` / low |
| review | `gpt-6-luna` / high |
| acceptance | `gpt-6-luna` / high |
| request種別の各工程 | 未指定（CLIの既存設定。従来と同じ） |

- 既定値と利用枠の固定値は、本リポジトリの`workflow.config.json`（Git管理）に置く。
- ルートの会話による指定は`model <ID> <工程> <モデル> [推論レベル]`で`state.models`に保存し、既定値より優先する。開始時は`start-change`に同じ指定を付けられる。
- 推論レベルはCLIごとの許容値で検証する（Codex：low/medium/high/xhigh/max/ultra、Claude：low/medium/high/xhigh/max）。モデル固有の非対応値はCLIのエラーとして`failed`になる。
- ルートセッションのモデル（`gpt-6-luna`/low）はクライアントのCodex設定で決まる。ルートは判断を実行器へ寄せ、質問・回答をそのまま受け渡し、反映した割り当てを実行前に復唱する（skillに記載）。

### 4. 実行の起動

| | Codex | Claude |
| --- | --- | --- |
| 新規 | `exec --json -m <model> -c model_reasoning_effort=<effort> --sandbox <mode> --output-schema … -o …` | `-p --model <model> --effort <effort> --output-format json --json-schema <schema> --session-id <uuid> --permission-mode dontAsk --allowedTools …` |
| 再開 | `exec resume <thread_id> --json -m <model> -c model_reasoning_effort=<effort> -c sandbox_mode=<mode> --output-schema … -o …` | `-p --resume <id> …（同じ制限）` |
| 結果 | `-o`のファイル | 標準出力JSONの構造化出力 |
| usage | `turn.completed.usage` | 結果JSONの`usage`・`modelUsage` |

`--ephemeral`を外すため、Codexのセッション履歴はCodexの保存先に残る。開発対象には保存しない。

### 5. 回答後のセッション再開

`question`で停止した試行の`{ stage, cli, model, effort, sessionId }`を`state.session`に保存する。`answer`の後の実行で、工程と割り当てが一致すれば再開し、回答だけを入力として渡す。一致しない場合、再開がエラーの場合、`retry`の場合は`state.session`を捨て、従来どおり回答を含めて新規コンテキストで実行する。工程が進んだら`state.session`を消し、他の工程に引き継がない。

前回の設計ではセッションの保存・復旧が増えるため再開を採らなかった。今回は、回答後に調査をやり直さず途中の編集の経緯を保てる利点をとり、保存するのは直近の質問の1セッションだけ、失敗時は必ず新規に戻すことで復旧の複雑さを抑える。

### 6. 利用枠の確認

工程の開始前に、その工程のCLIの利用枠を取得する。

- Codex: `codex app-server`をstdioで起動し、`initialize`の後に`account/rateLimits/read`を送って`primary`・`secondary`の`usedPercent`を得る。
- Claude: `claude -p "/usage" --output-format json`の`result`から、セッションと週の使用率を正規表現で取り出す。

残り（100 − 使用率）を`workflow.config.json`の工程ごとの固定値と比べる。初期値は計測の根拠がない仮の値とする。

| 工程 | セッション枠の残り | 週枠の残り |
| --- | ---: | ---: |
| prereview、execute | 20% | 10% |
| review、acceptance | 10% | 5% |

- 不足時は新しい状態`limited`にし、モデルは呼ばない。`status`は利用枠の値・リセット時刻と「別モデルへの変更、またはリセット待ち」を示し、対応者はクライアントとする。
- 実行中にCLIが利用枠の上限で終了した場合も`limited`にする（Codexは`rate_limit_reached`系のエラー、Claudeは結果JSONのエラーを分類する）。
- `limited`からは、`model`でその工程を変更するか、`retry`で同じモデルのまま再開する。どちらも新規コンテキストで実行する。
- 取得に失敗した場合は判定せずに実行し、未取得を記録する。試行前後の値を`metrics.json`に残して固定値の見直しに使う。

### 7. Codex実行ファイルの探索

Windowsでは`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`のうち更新日時が最新のもの、なければ`PATH`の`codex`を使う。実行器専用の環境変数は設けない。解決したパスと`--version`を実行前確認の記録に残し、`preflight`・本実行・利用枠の取得で同じパスを使う。

### 8. アーカイブ

`archive <ID>`を追加し、`completed`の`change`ワークフローだけで`openspec archive <change> -y --json`を開発対象のcwdで実行する。結果をイベントに記録し、失敗してもcompletedは変えない。skillは、completedになったらルートがこのコマンドを実行して報告するよう指示する。

## Risks / Trade-offs

- [Claudeの`/usage`は文章で、表示形式が変わると読めない] → 読めなければ未取得として実行し、上限到達時の`limited`分類に頼る。
- [同梱Codexはalpha版で、アプリの更新でパスや挙動が変わる] → 毎回探索し、使用したパスと版を記録する。
- [Codexの再開で`-c sandbox_mode`が効かない可能性] → 実装時に読み取り専用の工程で書き込みが拒否されることを確かめ、効かなければ再開せず新規にする。
- [`dontAsk`の許可パターンの書き方を誤ると、prereviewが何も更新できないか範囲外を書ける] → 実行器による変更ファイルの検査で範囲外を失敗にし、許可パターンは実機で確認する。
- [再開したセッションは前提が古いまま残る] → 再開は直近の質問1件に限り、retryと割り当ての変更では新規に戻す。
- [固定値の利用枠判定は工程の大きさを考慮しない] → 試行前後の使用率を記録し、実績から値を見直す。
- [Codexのセッション履歴が実行器の外（Codexの保存先）に残る] → 開発対象には保存しない要求は守られる。READMEに保存先を明記する。

## Migration Plan

- `kind`・`models`・`session`がない保存済み状態は、`request`種別・既定の割り当て（request種別は未指定）として読む。completedの状態とログは書き換えない。
- `waiting`で停止中の旧ワークフローは保存セッションがないため、回答後は新規コンテキストで実行する。
- 戻す場合は前の版の実行器で、`request`種別のワークフローをそのまま再開できる。`change`種別は旧版では扱えない。

## Open Questions

- 利用枠の固定値の適正値。計測の蓄積後に`workflow.config.json`だけで変更する。
