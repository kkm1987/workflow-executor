# ダミー：経費集計
これはWorkflow Executorの評価用ダミーです。最小の1タスクでexpenses.jsとexpenses.test.jsのみを作成してください。

expenses.jsからsummarizeExpenses(entries)をexportする。入力は{category, amount}の配列で、categoryは空白除去後に空でない文字列、amountは0以上の安全な整数（円）。出力は{total, byCategory}。byCategoryは{category, total}の配列で、空白除去したカテゴリで合算し、カテゴリ名をJavaScriptの標準文字列比較の昇順に並べる。入力の配列や要素は変更しない。

空配列の出力は{total:0, byCategory:[]}。不正な入力（配列以外、nullなどの不正な要素、不正なcategory、負数・小数・NaN・文字列・安全整数外のamount）はTypeErrorを投げる。合算した結果が安全整数の範囲を超える場合はRangeErrorを投げる。追加仕様や外部依存は不要。

受け入れ条件：
- food:1200、travel:500、food:300の入力がtotal:2000、byCategory:[{category:'food',total:1500},{category:'travel',total:500}]になる。
- categoryの前後空白を除去して同じカテゴリへ合算する。0円も受け入れる。
- 空配列、全ての不正入力、合算のオーバーフロー、入力の非破壊性をNode.js標準テストで確認する。
- node --testが成功し、既存のpackage.json、AGENTS.md、existing-note.txtが保持される。
- ワークフローの状態・ログは開発対象に作らない。

不明な業務判断を必要としない、仕様が確定した試験です。指定された仕様に従って進めてください。
