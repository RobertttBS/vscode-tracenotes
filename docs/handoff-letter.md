# Letter to the next tracenotes session

- 目的:交接時,前一個 session 認為對本專案最重要、但你不會問到的三件事,加上這套 docs 最可能的退化方式與預防。
- 目標讀者:Opus 4.8 級別的接手 session。
- 修改權限:整篇改寫需先問使用者;過期事實可先驗證再更新。
- 最後更新日期:2026-07-05

環境層的通用信另有一封:`~/.claude/playbooks/letter-to-future-sessions.md`。本篇只講 tracenotes。

## 三件我沒被問、但你必須知道的事

### 1. `npm test` 現在全綠,紅字就是回歸
(2026-10-23 更新)原本的基線紅字已解決:`recoverTracePoints.test.ts` 改成 vitest,並新增 `src/traceManager.test.ts` 覆蓋 TraceManager 核心。任何 failed 都是你造成的,見 [diagnosis.md](diagnosis.md) #1。

### 2. TypeScript 是你 fan-out 編輯的安全網,但 build 不跑它
改一個概念要同步多檔(顏色 4 處、訊息 2 處)。(2026-10-23 更新)漏項現在全會編譯錯 —— `HIGHLIGHT_COLORS` 用 `satisfies`、dispatch switch 有 `never` 檢查。但 esbuild 不做型別檢查、`npm run lint` 也跑不了(eslint 未安裝),所以**一定要跑 `npm run typecheck`**,不然錯誤只出現在編輯器裡。(diagnosis.md #2)

### 3. persistence/index 不變式是承重牆,壞了不會 crash
TraceManager 是 `TraceTree[]` 的唯一合法變更者,`ensureReady()` 是唯一合法入口 gate,atomic-write 是唯一合法存檔法。破壞它們不會丟例外 —— 只會讓 index 與磁碟悄悄不同步,幾個 session 後才顯現成資料錯亂。CLAUDE.md「When uncertain」把它們列為 STOP。**把那條守則當絕對**,別聰明繞過。

## 這套 docs 最可能怎麼退化,與預防

1. **file:line 隨程式碼移動而過期。** 診斷裡的行號會漂。→ 對策:diagnosis.md 的證據都標 `2026-07-05 實跑`;[maintenance.md](maintenance.md) 規定「依賴前先重驗」。行號錯不是重寫理由,是重跑 grep 更新那一行。
2. **重複滋生 —— 有人把全域 playbook 的規則抄進 `docs/`。** 一旦 docs 變厚、和全域重複,兩處都要維護、且會互相矛盾(正是任務 B 要收斂的病)。→ 對策:薄檔是設計目標;maintenance.md 有明確偵測條件「某檔開始整段複述全域規則 → 刪複述」。看到就刪,別客氣。
3. **規則累加。** 每次踩坑都想加一條規則,規則互相稀釋。→ 對策:優先 append LESSONS、優先刪而非加;精簡門檻(diagnosis >5 條 / 單檔 >150 行)寫在 maintenance.md,到了就精簡。

## 交接狀態
七項交付(diagnosis、CLAUDE.md 外科增補、delegation、judgment、prompt-templates、maintenance、本信)全數落檔。證據於 2026-07-05 實跑取得。無未竟事項(「排除 recoverTracePoints.test.ts」一項已於 2026-10-23 以改成 vitest 解決)。
