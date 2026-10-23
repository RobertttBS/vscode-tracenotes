# Diagnosis — top-3 traps in this project's session harness

- 目的:記錄本專案 session 最容易出錯/失焦/漏 token 的前三名,附證據與明確修法。後續 docs 引用此檔。
- 目標讀者:Opus 4.8 級別的 Claude Code session(接手本專案者)。
- 修改權限:file:line 或指令輸出過期時,任何 session 可**先重跑驗證再更新**(見 [maintenance.md](maintenance.md));新增/刪除整條發現需先問使用者。
- 最後更新日期:2026-07-05(證據於此日實跑取得)

英文為主,與 CLAUDE.md 及 `~/.claude/playbooks/` 同語言,降低切換成本。

---

## #1 — (已解決 2026-10-23)`npm test` 曾在乾淨狀態顯示 "1 failed"

`src/recoverTracePoints.test.ts` 已改成 vitest(`vi.hoisted` + `vi.mock('vscode')`),不再需要 `npx ts-node`。現在乾淨的 `npm test` 全綠:
```
Test Files  10 passed (10)
      Tests  186 passed (186)
```
**判定:任何 failed 檔或 failed 測試都是回歸。** 新的測試若要載入 TraceManager,用 `vi.mock('vscode', () => import('./test/vscodeMock'))`(見 `src/traceManager.test.ts`)。

## #2 — 一個概念散落多檔;TypeScript 接住大部分,但有一處靜默漏接(最容易出錯)

**證據(2026-07-05 grep):** 新增一個 highlight 顏色需同步 **4 處**:
- `src/types.ts:11` — `HighlightColor` union
- `src/types.ts:60` — `HIGHLIGHT_TO_TAG`(`Record<HighlightColor, string>`)
- `src/decorationManager.ts:13` — `HIGHLIGHT_STYLES`(`Record<'default' | HighlightColor, …>`)
- `src/webview/components/TraceCard.tsx:68` — `HIGHLIGHT_COLORS`(`HighlightColor[]`)

新增一個訊息指令需同步 **2 處**:`src/types.ts:100` 的 union + `src/extension.ts` 的 dispatch switch(目前 21 個 case)。

**編譯器接哪些、漏哪些(有兩個靜默漏接處要人工顧):**
- **接得住**:兩個 `Record<HighlightColor, …>` 少 key → 編譯錯誤;訊息 switch 加了 union 沒有的 case → 編譯錯誤(字面量不在 union)。
- **靜默漏接 ①**:`HIGHLIGHT_COLORS` 是 `HighlightColor[]`(陣列,非 exhaustive map)→ 少一個 entry **照樣編譯**,只是 UI 色票不出現。
- **靜默漏接 ②**:dispatch switch **無 `default:` 也無 exhaustiveness 檢查**(`src/extension.ts:42–176`)→ union 加了指令但 switch 漏 case,**不報錯**,runtime **靜默忽略**該訊息。

**修法(可判定):**
- 改 `HighlightColor` 後:`npm run build` 通過,**再手動確認新色票在 TraceCard 出現**(編譯器不會警告 TraceCard 陣列漏項)。
- 加訊息指令後:同時 grep `src/types.ts` union 與 `src/extension.ts` switch,兩處都要有。

## #3 — 未限定範圍的搜尋/讀取會吃進 build 產物(最漏 token)

**證據(2026-07-05 `ls -la`):** 根目錄有 5 個 `*.vsix`(每個 ≈450–512 KB)、`package-lock.json`(270 KB)、`dist/` 的 minified bundle。

**危害:** `grep -r`、Glob `**/*`、或 Read 這些檔會灌爆 context。它們被 gitignore(`*.vsix`、`dist/`),所以 `git grep` 會略過,但**純 `grep -r` / Glob 不會**。

**修法(可判定):**
- 搜尋限定 `src/`;優先用 `git grep`(自動跳過 gitignore 的檔)。
- 永不 Read:`*.vsix`、`package-lock.json`、`dist/*.js`(minified,debug 用 source map — CLAUDE.md 已載明)。

---

## 需人工確認的事項

(目前無)
