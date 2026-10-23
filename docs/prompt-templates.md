# Prompt templates — tracenotes pre-fills

- 目的:把全域五種派工模板,先填好 tracenotes 專屬欄位,讓接手 session 直接複製。
- 目標讀者:Opus 4.8 級別的接手 session。
- 修改權限:新增本專案填空可先做;若與全域模板結構衝突,先問使用者(呼應 [maintenance.md](maintenance.md))。
- 最後更新日期:2026-07-05

**五種完整模板看全域檔:** `~/.claude/playbooks/prompt-templates.md`(Search / Implementation / Refactor / Research / Review,各含 REPORT 契約區塊)。本檔只提供本專案已填好的常用兩種;其餘直接用全域版並套下方「專案填空」。

## 每個 tracenotes 派工都要放的「專案填空」
貼進任一全域模板的對應 slot:
```
CONSTRAINTS: 遵守 /Users/robert/Desktop/vscode-tracenotes/CLAUDE.md。
  只透過 TraceManager 方法改 TraceTree[];勿碰 ensureReady() gate 或 atomic-write 流程。
BASELINE (務必知道): 乾淨的 `npm test` 全綠;任何 failed 檔或測試都是回歸。
  需要 vscode 的測試用 `vi.mock('vscode', () => import('./test/vscodeMock'))`。
勿讀 dist/(minified)、*.vsix、package-lock.json;搜尋用 `git grep`、限定 src/。
```

## Search(填好版)— model: haiku(關聯性模糊用 sonnet），type: Explore
```
GOAL: 在 src/ 找 {WHAT}。
WHY: 我要用來 {MOTIVATION}。
KNOWN ALREADY: 訊息匯流排型別在 src/types.ts;dispatch 在 src/extension.ts;
  trace 真相源在 src/traceManager.ts;webview 在 src/webview/。
SEARCH HINTS: 用 `git grep`(跳過 gitignore 產物);勿讀 dist/*.js(minified)。
ACCEPTANCE: 每個「X 在/不在這」都附你實際打開過的 file:line,或列出空手而回的確切搜尋字串。
REPORT BACK: 每個 hit 一行 file:line + 它在那做什麼。{+ 全域契約區塊}
```

## Implementation / bugfix(填好版)— model: sonnet, type: general-purpose
```
GOAL: 在 {FILES/AREA} {做什麼/修什麼}。
WHY: {使用者可見的動機}。
CONSTRAINTS + BASELINE: {貼上上方「專案填空」}。
ACCEPTANCE(回報前自己跑):
1. `npm test` 全綠(0 failed)
2. bugfix 需附一個重現該 bug 的測試,修前紅、修後綠
3. `npm run build` 與 `npm run typecheck` 通過
4. 若動到 HighlightColor:手驗新色票在 TraceCard 出現(TS 不接住陣列漏項)
REPORT BACK: 改了哪些檔各一行 what/why;acceptance 指令輸出末幾行。{+ 全域契約區塊}
```

其餘(Refactor / Research / Review)直接用全域模板 + 上方「專案填空」。Review 一律 fresh context;trace/persistence 改動的 review 用 sonnet 起跳,因其失敗是靜默的。
