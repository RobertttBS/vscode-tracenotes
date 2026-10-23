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
Test Files  12 passed (12)
      Tests  206 passed (206)
```
**判定:任何 failed 檔或 failed 測試都是回歸。** 新的測試若要載入 TraceManager,用 `vi.mock('vscode', () => import('./test/vscodeMock'))`(見 `src/traceManager.test.ts`)。

## #2 — 一個概念散落多檔;TypeScript 全接得住,但 `npm run build` 不做型別檢查(最容易出錯)

**證據(2026-07-05 grep):** 新增一個 highlight 顏色需同步 **4 處**:
- `src/types.ts:11` — `HighlightColor` union
- `src/types.ts:60` — `HIGHLIGHT_TO_TAG`(`Record<HighlightColor, string>`)
- `src/decorationManager.ts:13` — `HIGHLIGHT_STYLES`(`Record<'default' | HighlightColor, …>`)
- `src/webview/components/TraceCard.tsx:68` — `HIGHLIGHT_COLORS`(`HighlightColor[]`)

新增一個訊息指令需同步 **2 處**:`src/types.ts:100` 的 union + `src/extension.ts` 的 dispatch switch(目前 21 個 case)。

**編譯器接哪些(2026-10-23 起兩處靜默漏接已補):**
- `Record<HighlightColor, …>` 少 key → 編譯錯誤。
- `HIGHLIGHT_COLORS` 改用 `satisfies Record<HighlightColor, 0>` 的物件取 keys → 少色或多色都編譯錯誤。
- dispatch switch 的 `default:` 有 `const unhandled: never = msg` → union 加指令但漏 case 即編譯錯誤(`ready` 由 `StoryboardProvider` 自己處理,已從 callback 型別排除)。

**修法(可判定):** esbuild 不做型別檢查,`npm run lint` 目前也跑不了(eslint 未安裝)。改 `HighlightColor` 或訊息指令後跑 **`npm run typecheck`**(`tsc --noEmit`),綠才算同步完成。

## #3 — 未限定範圍的搜尋/讀取會吃進 build 產物(最漏 token)

**證據(2026-07-05 `ls -la`):** 根目錄有 5 個 `*.vsix`(每個 ≈450–512 KB)、`package-lock.json`(270 KB)、`dist/` 的 minified bundle。

**危害:** `grep -r`、Glob `**/*`、或 Read 這些檔會灌爆 context。它們被 gitignore(`*.vsix`、`dist/`),所以 `git grep` 會略過,但**純 `grep -r` / Glob 不會**。

**修法(可判定):**
- 搜尋限定 `src/`;優先用 `git grep`(自動跳過 gitignore 的檔)。
- 永不 Read:`*.vsix`、`package-lock.json`、`dist/*.js`(minified,debug 用 source map — CLAUDE.md 已載明)。

---

## 需人工確認的事項

(目前無)
