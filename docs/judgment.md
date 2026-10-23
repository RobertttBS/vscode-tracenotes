# Judgment — tracenotes worked examples

- 目的:把全域判斷 rubric 落到本專案的具體情境。每條給一個本專案的正例(照做)與反例(別做)。
- 目標讀者:Opus 4.8 級別的接手 session。
- 修改權限:新增/改寫判準需先問使用者;新增本專案例子可先做(呼應 [maintenance.md](maintenance.md))。
- 最後更新日期:2026-07-05

**判準本體看全域檔:** `~/.claude/playbooks/judgment.md`(6 條 rubric 各含通用正/反例)。本檔只補 tracenotes 情境。

## Rubric 2 — 何時算真的完成
本專案「完成」= 三個都綠、且在**最後一次編輯後**跑過:
1. `npm test` **全綠**(0 failed,見 [diagnosis.md](diagnosis.md) #1)
2. `npm run build` 通過
3. `npm run typecheck` 通過(`npm run lint` 目前跑不了:eslint 未安裝)
- ✅ 正例:改完顏色後跑 `npm run typecheck` + `npm run build` + `npm test` 全綠(`TraceCard` 的 `HIGHLIGHT_COLORS` 漏項會被 typecheck 抓到)。
- ❌ 反例:`npm test` 有 1 個 failed 就宣稱「那個測試跟我無關,完成」——基線已全綠,任何紅字都是你的回歸。

## Rubric 3 — 何時停下來問使用者
- ✅ 正例:要動的東西落在 CLAUDE.md「When uncertain」清單 —— 在 TraceManager 方法**外**改 `TraceTree[]`、移除 `ensureReady()` gate、改 atomic-write 流程。這些破壞是靜默的、且難復原 → 停,提方案再問。
- ✅ 正例:測試失敗原因不明 —— CLAUDE.md 明令「test fails unclear → don't edit the test, ask」→ 問。
- ❌ 反例:新增一個 highlight 顏色但沒指定色碼 —— 4 個觸點都已知、機械性、易復原 → 挑一個與現有色調協調的值,一句話說明後逕自做,別問。

## Rubric 4 — 方向錯了的訊號(換路,不要重試)
- ✅ 正例:為了讓改動編譯過,你正要去改 `src/types.ts` 的 union 或某個 `.test.ts` 的斷言 —— 全域 rubric「about to modify a test/type to make your change fit」+ CLAUDE.md「don't edit the test, ask」。停,退一層,先寫一段為什麼原路走不通。
- ❌ 反例:build 失敗只是因為漏了 `HIGHLIGHT_STYLES` 一個 key(`Record` 少 key 的編譯錯)—— 這不是方向錯,補上那 key 即可。

## Rubric 5 — 品質底線(宣稱完成前逐項過)
除全域 6 項外,本專案務必加驗:
- **Fan-out 觸點全數同步**:改 `HighlightColor` → grep 4 處(diagnosis.md #2)並跑 `npm run typecheck`;加訊息指令 → grep types union + extension switch 兩處。
- **靜默失敗面**:trace/persistence 改動不會 crash,只會讓 index/disk 不同步 —— 底線是跑一次真實流程(加 trace → 存檔 → reload)或至少 `npm test` 綠,不能只靠「看起來對」。
- ✅ 正例:改完訊息指令,grep 證實 types union 與 extension switch 都有該 case,`npm test`(Tests 綠)+ build + typecheck 全過。
- ❌ 反例:在 types.ts union 新增了指令,卻沒跑 `npm run typecheck` 就宣稱完成。switch 的 `never` 檢查會報漏掉的 case,但 esbuild 不做型別檢查,`npm run build` 照樣綠 → 該訊息在 runtime 被靜默忽略。
