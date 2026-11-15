# OpenSpec Change間の横断的整合性：調査結果と導入計画

調査日: 2026-11-15。一次情報（各リポジトリのソース・コマンド定義・Issue・リリースノート、ローカルの`@fission-ai/openspec@1.10.0`）で確認した事実と、推測・未確認を区別して記す。

## 0. 結論（先に）

- **OpenSpec Change群の意味的な横断整合性を検出する既存OSSは見つからなかった。** 候補はすべて「単一仕様内の整合性」「構造的な台帳照合」「ファイル重複の検出」のいずれかで、複数Changeの要求・データモデル・状態遷移の矛盾は扱わない。
- 推奨は **C＋D（軽量）**：既存OSSのレビュー観点（spec-kit `analyze`の検出パス、speckit-roadmapの台帳項目と判定区分、BMADの「architecture spine」）を移植し、**Workflow Executorの工程として**横断レビューを1つ追加する。依存関係は人が保守するマップにせず、**決定的に抽出できるもの（要求名・ファイルの重複）は毎回再計算、高コストな推論結果（共通不変条件・意味的な依存）だけをAIが生成・更新する1ファイル（Phase spine）に残す。**
- Workflow Executorには既に「changeの実行前レビュー（prereview）で他のchangeと照合する」指示があるが、これは**実装直前・1change単位・範囲不定**で行われ、最も遅く最も高い時点のチェックになっている。改善の本質は、この照合を「Phase開始時に1回」「変更時に影響範囲だけ」へ移すこと。

## 1. 関連OSS・スキルの調査結果

### 1.1 機能の区別

| 機能 | spec-kit analyze | speckit-roadmap | spec-kit-orchestrator | spec-kit-critique | OpenSpec 1.10/2.0 | BMAD architecture |
|---|---|---|---|---|---|---|
| 仕様の意味的な矛盾検出 | 単一feature内のみ（spec/plan/tasks間） | なし | なし | 単一featureの観点レビュー | なし（構造検証のみ） | spine検証（invariant違反） |
| 共通方針との整合性 | constitution照合 | roadmap項目との照合（brief/debrief、1spec単位） | なし | constitution照合 | なし | 親spineとの矛盾を「conflict」として提示 |
| 仕様間の依存関係推定 | なし | 人が書く`depends on`を照合（存在・abandoned判定のみ） | tasks.mdの記述から抽出 | なし | なし | spine内の境界・依存規則 |
| ファイル・作業の競合検出 | なし | なし | **あり**（tasks.mdのパス文字列＋動詞ヒューリスティック） | なし | 同一要求を2changeが変更する検出は**PR未マージ**（#1963/#1698） | なし |
| 変更時の影響範囲分析 | なし | debriefで「roadmap-stale」等を分類（1spec） | なし | なし | なし | update時の再検証 |
| 計画・順序の管理 | なし | ledgerのstatus | `next`で未ブロックのタスク抽出 | なし | なし（initiativeは**廃止済み**） | ticket階層 |

### 1.2 個別評価

**GitHub Spec Kit `/speckit.analyze`**（MIT、約15万★、v1.4.0 2026-11-10、活発）
- 読み取り専用。1つのfeatureの`spec.md`・`plan.md`・`tasks.md`とconstitutionを読み、A:重複 B:曖昧 C:不足 D:constitution整合 E:カバレッジ F:不整合（用語ゆれ・エンティティ不一致・順序矛盾・要求矛盾）を検出。CRITICAL〜LOWの重大度、50件上限、要求→タスクのカバレッジ表を出す。
- **複数featureには適用されない**（`FEATURE_DIR`1つを前提）。
- 「Spec of Specs」は公式ドキュメント`docs/how-to/spec-of-specs.md`（PR #3648、2026-07マージ）として存在するが、**手作業のroadmap Markdownを書く手順書であり、ツールではない**。同期も人手。
- 再利用: 検出パスA〜Fと重大度体系は、Change横断にもほぼそのまま使える。最も成熟した「観点」の供給源。

**speckit-roadmap**（Apache-2.0、10★、最終push 2026-10-10、spec-kit ≥0.11.6の拡張）
- `.specify/memory/roadmap.md`に Vision / Constraints & Decisions / Planned Specs（status, outcome, scope in/out, depends on, governed by）を保持。`write`だけが編集し、`brief`（実装前）・`debrief`（実装後）・`sync`（随時）は読み取り専用レポート。
- **整合性検証は「1つのspec ↔ roadmap項目」の比較**。`sync`は orphan / phantom / status drift / dependency-contradiction（依存先が存在しない・abandoned）という**構造的照合**で、内容を深く読まないと明記している。複数spec同士の意味的矛盾は検出しない。
- roadmapは対話で人が承認しながら作る前提＝**人手保守の負担がある**。
- 再利用: ledgerの項目設計、debriefの分類（outcome-miss / scope-creep / constraint-violation / **roadmap-stale＝仕様側でなく台帳側が古い**）、判定（PROCEED / PROCEED WITH UPDATES / RETHINK）、「読み取り専用で提案、適用は別コマンド」の分離。

**spec-kit-orchestrator**（**ライセンス表記なし**、6★、最終push 2026-04-24、プロンプト4本のみ）
- spec-kit #2238（closed）を拡張で解決したもの。`status`（全featureの進捗）、`next`（横断タスク抽出）、`conflicts`（tasks.mdに書かれたパス文字列の重複を additive/modifying/replacing に分類）、`sync`（`specs/status.json`出力）。
- **意味的整合性の機能はなく、拡張の土台にするほどのコードもない**（ロジックはすべてプロンプト内）。ライセンス未指定のため**コードの複製は不可、着想のみ利用**。
- 再利用: ファイル重複の分類ヒューリスティック（決定的に実装可能）。

**spec-kit-critique**（MIT、3★、最終push 2026-04-01）
- 1featureのspec/planを Product lens（3a〜3e）と Engineering lens（4a〜4g）でレビュー。横断機能なし。
- 再利用: Engineering lensの 4a 境界・インターフェース、4g 統合点・後方互換 の質問だけを横断レビューのチェックリストに取り込む。Product lensは今回の課題に対して費用対効果が低い。

**OpenSpec本体**（ローカル`1.10.0`、最新`v2.0.0` 2026-11-11）
- `validate`は**各changeを現在のmain specと比較するだけ**。2つのactive changeが同じ要求を変更しても両方通り、先にarchiveした側の後で初めて失敗する。これを検出する提案 PR #1963（設計）/ #1698（実装）は**未マージ**。#1112（MODIFIEDヘッダーの存在確認）も open。
- `doctor`はstore・参照先のヘルスチェック、`workset`は作業フォルダーのビュー、`context`は作業コンテキスト出力で、**いずれも仕様内容の整合性ではない**。
- change metadataの`initiative`・`affected_areas`はスキーマに残るが、`new change --initiative`は「No longer supported」で**廃止済み**。Phaseのグループ化機能は現行OpenSpecにない（#889 roadmap→change対応付けは open）。
- v2.0.0では skillが`.agents/skills/`に集約され`/opsx:*`コマンドが削除される。このリポジトリには`.claude/commands/opsx`があるため、**更新時に影響あり（本計画とは別件）**。

**BMAD-METHOD `bmad-architecture`**（約5.5万★、2026-11も活発、ライセンス表記はNOASSERTION）
- 「architecture spine」= 独立に作られる単位が乖離しないための**不変条件（invariants）だけ**を固定する短い契約。構造（スタック・ツリー）はコードが持つものとして最小限にする。子（epic）は親spineのADを読み取り専用制約として継承し、矛盾は「ローカルな上書きでなく表面化すべきconflict」とする。
- 以前のBMADにあった`correct-course`（スプリント中の変更影響分析）や実装準備チェックは、2026-11時点のmainには独立スキルとして存在しない（再編済み。第三者レジストリには旧版が残る）。
- 再利用: **Phase spineの考え方そのもの**。「全仕様を要約した文書」ではなく「Change間で共有される不変条件だけ」を持つことで、保守量と読み込み量を最小化できる。

**その他（未検証）**: 検索で`cross-spec-review`（super-puper-powers、複数specのインターフェース整合・seam gap・矛盾・ビルド順を確認）が見つかったが、ソースは未確認。OpenSpec #783（単一change内の意味的レビューskillの要望）、`openspec-ext-review-plan`（単一change）も同系統で横断ではない。

### 1.3 比較表

| 観点 | analyze | roadmap | orchestrator | critique | OpenSpec | BMAD spine |
|---|---|---|---|---|---|---|
| 今回の問題への適合性 | 中（観点のみ） | 中（台帳・分類） | 低 | 低 | 低（将来overlap検出） | 中〜高（概念） |
| 横断的な意味的分析 | × | × | × | × | × | △（spine照合） |
| OpenSpecへの統合容易性 | 高（プロンプト移植） | 中（spec-kit前提のスクリプト） | 中 | 高 | ― | 中（概念移植） |
| 分析ロジックの再利用性 | 高 | 中 | 低（ライセンス無） | 中 | ― | 中 |
| 保守負担（採用時） | 低 | 中〜高（人手roadmap） | 低 | 低 | ― | 中 |
| 実行コスト | 1feature分 | 1spec分 | 小 | 1feature分 | ― | spine1枚 |
| 成熟度・継続性 | 高 | 低（個人・10★） | 低（停止気味） | 低 | 高 | 高 |

## 2. 既存技術で対応できる範囲と不足

| 中心課題 | 既存で対応可能 | 不足 |
|---|---|---|
| A. 開始前の横断整合性 | 1change内の矛盾・カバレッジ（analyze観点を流用）、ファイル重複（orchestrator方式）、要求重複（OpenSpec PR #1698の方式を自前で数十行） | **複数Changeの意味的矛盾、暗黙の前提、共通データモデル・状態遷移の不整合、横断で初めて判明する欠落**＝全OSSで未対応 |
| B. 途中の整合性維持 | 変更の検出（Workflow Executorが既に`openspec/`配下の前後差分を証拠として記録）、replanの記録 | **変更から影響Changeを選ぶ仕組み**、実装済み/実装中/未着手の区別、計画更新の提案 |
| C. フィードバック高速化 | 読み取り専用レビュー＋提案と適用の分離（全OSS共通の型）、`openspec-update-change` skillによる修正適用 | **実行タイミングの判断基準**、評価データ |

## 3. 推奨構成と選定理由

### 3.1 方式比較

| 方式 | 評価 |
|---|---|
| A. 既存OSSをそのまま利用 | 不可。どれも横断の意味分析をしない。spec-kitの`specs/`構造前提でOpenSpecと非互換。 |
| B. 既存OSSを移植 | 移植価値のある「コード」がほぼない（ロジックはプロンプト）。roadmapの`load-config`スクリプトは不要。 |
| **C. 設計思想と観点を使った軽量スキル** | **採用**。analyzeの検出パス＋roadmapの台帳・分類＋spineの不変条件をプロンプトとして移植。 |
| **D. 意味分析＋依存管理の組合せ** | **軽量版を採用**。依存は手書きマップにせず、決定的に再計算できる部分（要求名・ファイル）とAIが生成する意味的依存に分ける。 |

### 3.2 構成

```
            ┌─────────────── 決定的な前処理（LLMなし、毎回再計算）──────────────┐
active      │ ・各changeのdelta要求名（openspec show --json --deltas-only）     │
changes ──▶ │ ・同一要求を複数changeが ADDED/MODIFIED/REMOVED → overlap        │
            │ ・tasks.md/design.mdのファイルパス重複（additive/modifying/replacing）│
            │ ・完了タスクの実変更ファイル（既存の証拠 before/after.json）       │
            └──────────────────────────────┬────────────────────────────────┘
                                           ▼
                     phase-review（読み取り専用の工程、1回のLLM呼び出しが基本）
                     入力: 対象changeの proposal/design/delta specs/tasks、main specs、
                           Phase spine、overlap表、関連コードの抜粋
                     出力: findings（JSON）＋ Phase spine の更新案
                                           ▼
                     所有者が採否 → openspec-update-change で各changeを修正
                     → 修正したchangeとそのspine隣接changeだけ再レビュー
```

**Phase spine（`openspec/phases/<phase>.md`、AIが生成・更新、人は承認のみ）** に残すのは次だけ：

1. メンバーchange一覧と状態（Workflow Executorの状態から自動）
2. **共有不変条件**：共通データモデルのキー・所有者、インターフェース契約、状態遷移、命名。各項目に出典（change名・要求名）
3. **意味的依存**：`A → B（Aは Bの要求Xを前提）`。根拠の引用必須、根拠なしの依存は書かない
4. 未解決の不確実性・技術リスクと、検証するchange・タスク

要求名やファイルの重複は spine に書かない（毎回再計算できるので保守対象にしない）。

### 3.3 選定理由

- **意味的な矛盾の発見がLLMでしかできない以上、その観点（プロンプト）が成果の大半**。analyzeは最も成熟した観点の供給源、roadmap/spineは「何を記録し、何を記録しないか」の設計を提供する。
- **依存関係マップの保守負担（6.1）**：手書きの`depends on`は roadmap の`sync`が示すとおり腐る。決定的部分は再計算、意味的部分は「レビューのたびにAIが差分更新、人は承認だけ」にすることで手作業をなくす。spineがあることで変更時にAIが毎回全changeを読まずに済む（＝トークン削減）のが記録する理由。
- **実行器への組み込み**：Workflow Executorは既にOpenSpecの前後差分・replan・試行ごとのトークン/時間（`metrics.json`）を記録している。トリガーと評価の材料が揃っており、独立スキルより工程として足すほうが変更が少ない。

## 4. OpenSpec / Workflow Executorへの組み込み

### 4.1 実行タイミング

| タイミング | 実行内容 | 範囲 |
|---|---|---|
| T1: Phaseのchange群を作成した後 | `phase-review`（フル） | Phase全change＋main specs＋関連コード抜粋 |
| T2: 各changeの通常実行 | 既存prereviewに**そのchangeのspine該当部分とoverlap行だけ**を渡す。「他のchangeと照合」の汎用指示は置き換える | 1change |
| T3: 仕様・設計変更の発生時 | `phase-review --impact`（差分起点） | 変更change＋影響候補 |
| T4: 節目 | 条件付きでフル再実行（固定頻度にしない） | 全change |

**T3の起動条件（実行器が判定）**
- prereview・executeの後、証拠の`openspec`差分で**他changeから参照される要求・spine不変条件・design上のインターフェース**に変更がある
- executeが`replan`を返し、summaryの変更ファイルが他changeのoverlap表と重なる
- 所有者の回答で仕様変更が入った

**影響候補の選択（安い順）**
1. overlap表で同じ要求名・同じファイルを持つchange（決定的）
2. spineで変更箇所に依存しているchange
3. 変更した不変条件の出典change
4. 候補が空でも「spine不変条件そのものが変わった」「影響判定がunknown」なら**フルに拡大**

**T4の起動条件**: 被依存数が多いchange（spineのハブ）の完了時、T3が同一Phaseで累計N回（初期値3）、Phase統合前の最終確認。

### 4.2 入力

- 必須: 対象changeの`proposal.md`・`design.md`・delta specs・`tasks.md`、関連main specs、Phase spine、overlap表
- コード（6.2への回答）: **全文は読ませない**。overlap表のファイルと、design/specが名指しするインターフェース定義・スキーマ・型定義だけを読む。実装済みタスクがあるchangeは、そのタスクの実変更ファイル（証拠から）を加える。これで「仕様上は整合しているが既存コードの暗黙インターフェースと矛盾」を拾い、全体走査のコストは避ける。

### 4.3 エージェントへの指示（要点）

```
読み取り専用。changeを編集しない。
検出パス（spec-kit analyze A〜Fを横断へ拡張）:
 X1 要求矛盾: 2つ以上のchangeで両立しないSHALL/MUST
 X2 重複: 同じ振る舞いを複数changeが定義
 X3 共有モデル不整合: エンティティ・フィールド・状態遷移・エラー形式の食い違い
 X4 暗黙の前提: change AがBの要求・成果物を前提にしているがBに定義がない、または順序が逆
 X5 横断欠落: 各changeは完結しているが、つなぎ（移行・初期化・権限・エラー伝播）が誰の担当でもない
 X6 spine違反: 共有不変条件・アーキテクチャ方針との不一致
 X7 既存コード不整合: 読んだコードの実インターフェースと仕様の食い違い
 X8 未検証リスク: 実装前に試作・計測すべき不確実性
各指摘は必ず両側の出典（change/ファイル/要求名）を引用。引用できない指摘は出さない。
roadmap-stale相当（仕様は正しくspineが古い）はspine更新案として分類し、欠陥と呼ばない。
重大度: blocker（このまま実装すると手戻り確定）/ major / minor / question。上限30件。
影響タスクを done / in-progress / pending に分類（tasks.mdのチェックと実行器の状態から）。
```

### 4.4 出力形式（`result.schema.json`と同様にJSONで受ける）

```json
{
  "verdict": "proceed | proceed_with_updates | rethink",
  "findings": [{
    "id": "X3-1", "pass": "X3", "severity": "blocker",
    "changes": ["auth-session", "admin-users"],
    "evidence": [{"change": "auth-session", "file": "specs/session/spec.md", "quote": "..."}],
    "summary": "...", "proposal": "...",
    "impact": [{"change": "admin-users", "task": "2.3", "state": "done"}]
  }],
  "spineUpdates": [{"op": "add|modify|supersede", "section": "invariants|dependencies|risks", "text": "...", "source": "..."}],
  "order": {"changed": true, "proposal": ["..."], "reason": "..."},
  "scope": {"reviewed": ["..."], "escalated": false, "reason": "..."}
}
```

### 4.5 修正・再レビューの流れ

1. `phase-review`の結果を状態に保存し、blocker/majorを質問として所有者へ提示（既存の`waiting`/`answer`の仕組み）
2. 承認された指摘ごとに、対象changeへ`openspec-update-change`相当の修正を**既存のprereview（change内編集のみ許可）として**実行。spineの更新はphase-review工程にだけ許可
3. 影響を受けた**done**タスクは修正タスクとしてtasks.mdへ追加（既存の「修正タスクを足す」規則を流用）、**in-progress**は実行中なら`replan`扱い、**pending**は仕様修正のみ
4. 再レビューは修正したchangeとspine隣接changeだけを`--impact`で実行。同じ指摘IDの解消確認を含める

## 5. 仕様変更時の横断的整合性維持フロー

```
変更発生（prereviewのopenspec差分 / execute replan / 所有者回答）
  │
  ├─ 差分が当該change内に閉じ、overlap・spine参照なし ─▶ 何もしない（局所検証のみ）
  │
  ├─ 影響候補を選択（overlap → spine依存 → 不変条件の出典）
  │     └─ 不変条件変更 or 判定不能 ─▶ フル phase-review
  ▼
phase-review --impact（候補changeだけ）
  ▼
指摘を done / in-progress / pending に分類 → 所有者承認 → 各changeを更新
  ▼
spine更新（承認） → 実行順序の更新案があれば次のchange選定に反映
```

## 6. 最小導入案と段階的拡張

### 初期導入（MVP、既存運用をほぼ変えない）

1. **決定的なoverlap抽出**（実行器内、小さな関数＋テスト）: active changeのdelta要求名とtasks/designのパスから重複表を作る。`openspec show --json --deltas-only`を使い、OpenSpecにPR #1698が入ったら置き換える。
2. **`phase-review`工程とCLIコマンド**: `node src/cli.js phase-review <対象> --changes a,b,c`（または`--prefix`）。読み取り専用＋`openspec/phases/`だけ書き込み可。プロンプトは4.3、出力は4.4。
3. **prereviewへの入力追加**: 選定したchangeのspine該当部分とoverlap行を渡し、「他のchangeとの照合」の汎用指示をこれで置き換える。

T3（自動トリガー）はMVPでは**手動実行**（変更に気づいたら`phase-review --impact <change>`）とし、運用で必要性を確かめる。

### 拡張（効果を測ってから）

- E1: T3の自動トリガー（4.1の条件を実行器が判定）
- E2: T4の条件付き再実行
- E3: 評価ハーネス（7章）の自動化
- E4: OpenSpec v2.0への更新（`/opsx:*`削除への追従。本件とは独立）
- E5: OpenSpecにcross-change overlapが入ったら自前抽出を削除

### 確認が必要な前提

- `openspec/phases/`は OpenSpec 1.10.0 の`validate --all`・`list`で無視されることを確認済み（v2.0.0は未確認）
- Phaseの所属をどう決めるか（OpenSpecに機能がないため、命名接頭辞かphase-review時の明示指定。spineのメンバー一覧を正とする）

## 7. 品質・速度・運用負担の評価方法

### 回帰評価データの作り方

1. **過去事例の再生**: 対象リポジトリのgit履歴から、Phase開始時点のchange群のコミットを特定する。その後の`replan`記録（実行器の`events.jsonl`、`state.replans`）とchange修正コミットのうち、**原因が他changeとの不整合だったもの**を正解ラベルにする。開始時点のスナップショットに`phase-review`を当て、事前に検出できたかを見る。
2. **注入テスト**: 整合しているchange群に既知の矛盾（フィールド型の食い違い、状態遷移の欠落、前提changeの削除など）を1件ずつ入れ、検出されるかを見る。件数を増やしやすく、プロンプト変更時の回帰確認に使う。

### 指標

| 指標 | 取り方 |
|---|---|
| 検出率 | 再生事例・注入事例のうち、同じ原因を指したblocker/major指摘の割合 |
| 誤指摘率 | 所有者が「不採用」とした指摘の割合（状態に採否を残す） |
| 重大な見逃し | Phase完了までに発生した横断原因のreplanのうち、直前のレビューで指摘されなかった件数 |
| 実行時間・トークン | 既存の`metrics.json`（試行単位） |
| 手戻り削減 | Phaseあたりの横断原因replan回数・手戻り時間を導入前のPhaseと比較 |

判断基準の目安: フルレビュー1回のコストが、そのPhaseで防げた手戻り1件分（再計画＋再実装の試行コスト）を下回るか。下回らない観点（パス）は削る。

## 出典

- spec-kit analyze: https://github.com/github/spec-kit/blob/main/templates/commands/analyze.md
- spec-kit Spec of Specs: https://github.com/github/spec-kit/blob/main/docs/how-to/spec-of-specs.md 、https://github.com/github/spec-kit/pull/3648
- spec-kit cross-feature issue: https://github.com/github/spec-kit/issues/2238
- speckit-roadmap: https://github.com/srobroek/speckit-roadmap （commands/、README.md）
- spec-kit-orchestrator: https://github.com/Quratulain-bilal/spec-kit-orchestrator
- spec-kit-critique: https://github.com/arunt14/spec-kit-critique （commands/run.md）
- OpenSpec: https://github.com/Fission-AI/OpenSpec/releases （v1.16.0〜v2.0.0）、PR #1963・#1698、Issue #1112・#889・#2201・#783
- BMAD-METHOD: https://github.com/bmad-code-org/BMAD-METHOD/blob/main/skills/method/bmad-architecture/SKILL.md
