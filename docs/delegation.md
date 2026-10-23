# Delegation — tracenotes specifics

- 目的:本專案在什麼情況下該派 subagent、派哪種,以及派工時必須告訴 agent 的專案事實。通用方法不重複,一律引用全域檔。
- 目標讀者:Opus 4.8 級別的接手 session。
- 修改權限:調整下方門檻/表格需先問使用者;修正過期 file:line 可先驗證再改(見 [maintenance.md](maintenance.md))。
- 最後更新日期:2026-07-05

**通用方法看全域檔,不在此重述:** `~/.claude/playbooks/delegation.md`(門檻、派工三件套、回報合約、升降級梯、不自驗)與 `~/.claude/playbooks/prompt-templates.md`。本檔只放 tracenotes 專屬 delta。

## 這個 repo 裡「不要派」的事(在全域門檻之下,inline 做)
- **新增 highlight 顏色**:只碰 4 個已知檔(見 [diagnosis.md](diagnosis.md) #2),模式已知 → inline 改,`npm run build` 驗。
- **新增訊息指令**:2 個已知觸點(types union + extension switch)→ inline。
- **單一 hook/component 的行為調整**:在 `src/webview/` 內單檔 → inline。

## 這個 repo 裡「該派」的事
- **跨 trace 資料流的「X 在哪」**(TraceManager ↔ 訊息匯流排 ↔ decoration 三方如何串)→ `Explore`(haiku;關聯性模糊時 sonnet)。搜尋限定 `src/`。
- **已驗證模式的批次套用**且觸點 >5 檔 → `general-purpose`(haiku,模式已證);tracenotes 目前少見這種規模。
- **對「已完成的 trace/persistence 改動」做對抗式審查** → `general-purpose`(sonnet,fresh context),因為 index/disk 同步錯誤是靜默的(不 crash),自驗看不出來。

## 派工時**必須**寫進 prompt 的專案事實(否則 agent 會誤判)
1. **`npm test` 必須全綠**:「乾淨狀態 `npm test` 全綠,任何 failed 都是回歸;動到 TraceManager 要跑 `src/traceManager.test.ts`。」(diagnosis.md #1)
2. **只透過 TraceManager 改 `TraceTree[]`**,別碰 `ensureReady()` gate 與 atomic-write 流程(CLAUDE.md「When uncertain」)。
3. **別叫 agent 讀 `dist/`(minified)、`*.vsix`、`package-lock.json`** — 用 source / `git grep`。(diagnosis.md #3)

## 驗證(呼應全域「不自驗」)
派出去的 trace/persistence 改動,回來後由**你或 fresh-context agent 重跑** `npm test`(讀 `Tests` 行)+ `npm run build` + `npm run typecheck`,不採信 agent 自報綠燈。高風險判斷(改動 guarded flow)加第二意見:全域 delegation.md「Verification is never self-verification」。
