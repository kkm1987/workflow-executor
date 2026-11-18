# Change横断の整合性：Workflow Executorへの組み込み計画

複数のOpenSpec Change（1 Phase＝10〜20 Change）の横断的な整合性レビューは、独立したskill **OpenSpec Phase Review**（`C:\products\openspec-phase-review`）として開発する。OSS調査、レビュー観点、Phase spine、出力スキーマ、出力ファイルの配置、評価方法はそちらの`docs/plan.md`にある。

この文書は、Workflow Executor側でだけ必要な計画を扱う。

## 1. 分担

| | OpenSpec Phase Review（skill） | Workflow Executor |
|---|---|---|
| 担うこと | どうレビューするか：検出観点、範囲（フル／影響範囲）の判定、spine、出力スキーマ、決定的な重複表 | いつ・どの範囲で呼ぶか：起動判定、構造化出力の検証、書き込み範囲の制限、指摘の所有者への提示と修正の実行 |
| 単体での利用 | Phase計画直後のチャットから直接呼ぶ | ― |

観点は実行器に重複して書かない。実行器の工程はskillの`SKILL.md`と参照ファイルを指示として読み込み、出力をskillの`references/result.schema.json`で検証する。

## 2. 現状の課題（実行器側）

prereviewには「現在のコード・既存仕様・他のchange・実行環境と照合して実行可否を判断する」指示がある。この照合は実装直前・1change単位・範囲不定で行われ、横断の問題を見つける時点として最も遅くコストが高い。これを「Phase開始時に1回（skill）」「変更時に影響範囲だけ（実行器が起動）」へ移す。

## 3. 実行タイミング

| タイミング | 実行器の動作 | 範囲 |
|---|---|---|
| T1: Phaseのchange群を作成した後 | 実行器は関与しない。チャットからskillを直接呼ぶ | Phase全change |
| T2: 各changeの通常実行 | prereviewに**そのchangeのspine該当部分と重複表の行だけ**を渡し、「他のchangeと照合」の汎用指示を置き換える | 1change |
| T3: 仕様・設計変更の発生時 | `phase-review`工程を影響範囲モードで起動 | 変更change＋影響候補（候補の選び方はskill側） |
| T4: 節目 | 条件付きでフルモードを起動（固定頻度にしない） | 全change |

**T3の起動条件**
- prereview・executeの後、証拠の`openspec`差分で**他changeから参照される要求・spine不変条件・design上のインターフェース**に変更がある
- executeが`replan`を返し、summaryの変更ファイルが他changeとの重複表と重なる
- 所有者の回答で仕様変更が入った

**T4の起動条件**: 被依存数が多いchange（spineのハブ）の完了時、T3が同一Phaseで累計N回（初期値3）、Phase統合前の最終確認。

## 4. `phase-review`工程

- skillの指示を読み込み、出力をskillのスキーマで検証する（既存の`result.schema.json`・`prereview.schema.json`と同じ扱い）。
- 書き込み許可は`<OpenSpecルートの親>/phases/`だけ。changeは編集しない。既存のprereviewの「change内のみ編集可」は変えない。
- OpenSpecルートとstoreは案件開始時に固定したものを使う（既存の仕組み）。
- 実装済みタスクの変更ファイルは、既存の証拠（`before.json`・`after.json`）からskillへ渡す。

## 5. 指摘の修正と再レビュー

1. `phase-review`の結果を状態に保存し、blocker/majorを質問として所有者へ提示する（既存の`waiting`/`answer`）
2. 採用された指摘ごとに、対象changeの修正を**既存のprereview（change内編集のみ許可）として**実行する
3. 影響を受けたタスクの扱い:
   - done: 修正タスクとしてtasks.mdへ追加（既存の「修正タスクを足す」規則を流用）
   - in-progress: 実行中のタスクは`replan`扱い
   - pending: 仕様修正のみ
4. spineの更新案は所有者の承認後に`phase-review`工程が反映する
5. 修正したchangeを指定して影響範囲モードで再実行し、同じ指摘IDの解消を確認する

## 6. 作業計画

skillのMVP（skillリポジトリ側）が先。実行器側はその後、次の順で進める。

1. **prereviewの入力追加（T2）**: 選定したchangeのspine該当部分と、skillの`scripts/overlap.mjs`で作った重複表の行を渡す。汎用の照合指示を置き換える
2. **`phase-review`工程とCLIコマンド**: 例 `node src/cli.js phase-review <対象> --changes a,b,c [--impact <change>]`。4章の制約で実装
3. **T3の自動起動**: 3章の条件を実行器が判定する
4. **T4の条件付き再実行**
5. **評価データの提供**: 横断原因のreplanにラベルを付けられるようにし（`events.jsonl`・`state.replans`）、skill側の過去事例の再生と、`metrics.json`による時間・トークンの比較に使う

### 確認が必要な前提

- skillの配置場所の解決方法（実行器から見たskillのパス）。ユーザー用skillディレクトリのジャンクション経由か、設定で指定するか
- Phaseの所属の受け渡し（skill側はspineのメンバー一覧を正とする）

## 7. 本件と独立した注意点

OpenSpec v2.0.0（2026-11-11）で`/opsx:*`コマンドが削除され、skillは`.agents/skills/`に集約された。このリポジトリには`.claude/commands/opsx`があり、開発用依存関係は`@fission-ai/openspec@1.10.0`に固定している。更新時は`openspec update --dry-run`で影響を確認する。
