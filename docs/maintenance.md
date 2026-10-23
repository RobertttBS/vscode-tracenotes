# Maintenance — how to update these docs/ safely

- 目的:未來 session 如何安全更新 `docs/` 與 CLAUDE.md,以及踩坑教訓寫回哪裡。
- 目標讀者:Opus 4.8 級別的接手 session。
- 修改權限:本檔的 LESSONS 區塊可自行 append;改本檔「規則」需先問使用者。
- 最後更新日期:2026-07-05

**通用治理原則看全域檔:** `~/.claude/playbooks/maintenance.md`。本檔專講 tracenotes 的 `docs/`,一個關鍵差異:**這些檔已進版控(在 repo 內、非 gitignore)**,所以改動是 git 可見的 —— 隨引發它的那次 commit 一起提交,不要留未提交的 doc 漂移。

## 可自行改(不必問使用者)
- 修正 `docs/` 或 CLAUDE.md 裡**過期的 file:line / 指令 / 型別名**——但**先實跑或 grep 驗證正確值**,並在下方 LESSONS 記一行(附你跑的指令)。
- 在本檔 LESSONS 區塊 append 一筆踩坑教訓。
- 在 `docs/judgment.md`、`docs/delegation.md`、`docs/prompt-templates.md` 補**本專案的例子/填空**。

## 需先問使用者
- 改寫或刪除 CLAUDE.md 的任一條規則(append 一條有日期的例外可以;刪規則不行)。
- 動測試基建(vitest 設定、`src/test/vscodeMock.ts` 的共用行為)。
- 在 `docs/diagnosis.md` 新增或刪除整條「發現」。
- 任何觸及 CLAUDE.md「When uncertain」guarded flow 的建議。

## 踩坑教訓寫回哪裡(格式)
專案級教訓 → 本檔 LESSONS(下方)。環境級教訓 → 全域 `~/.claude/playbooks/maintenance.md` 的 LESSONS。格式:
```
### YYYY-MM-DD — <一行標題>
發生什麼: <最多 2 行>
要記住的規則: <1 行,祈使句>
證據: <跑的指令 / file:line / 錯誤文字>
```
不要記:全域 playbook 已寫過的、通用 coding 教訓、一次性瑣事。

## 精簡觸發條件(明確門檻)
- `docs/diagnosis.md` 的「發現」超過 **5 條**,或任一 `docs/` 檔超過 **150 行** → 向使用者提精簡(合併重複、把穩定的教訓升進對應 doc 規則、刪過時的)。精簡刪歷史,一律需使用者核准。
- **偵測重複滋生**:若某個 `docs/` 檔開始整段複述全域 playbook 的規則 → 刪掉複述,只留「引用 + 專案 delta」。薄檔是設計目標(見 [handoff-letter.md](handoff-letter.md))。

---

## LESSONS

### 2026-07-05 — docs/ 治理層建立
發生什麼: 一個 Fable 5 交接 session 建立此 `docs/` 層,作為全域 `~/.claude/playbooks/` 的本專案薄增量。
要記住的規則: `docs/` 引用全域方法,只放 tracenotes 專屬內容;別把全域規則複製進來。
證據: 見 [diagnosis.md](diagnosis.md)(證據於 2026-07-05 實跑取得)、[handoff-letter.md](handoff-letter.md)。

### 2026-10-23 — npm test 基線紅字解決,TraceManager 有了測試
發生什麼: recoverTracePoints.test.ts 改成 vitest;新增 src/test/vscodeMock.ts 與 src/traceManager.test.ts(20 個)。CLAUDE.md/AGENTS.md/docs 的「1 failed 基線」敘述全數更新。
要記住的規則: 呼叫會觸發背景驗證的方法(如 switchTree)後,測試要先 await validateActiveTreeBackground() 再存檔比對,否則會 flaky。
證據: `npm test` → Test Files 10 passed / Tests 179 passed;重跑 15 次穩定。

### 2026-10-23 — 索引一致性要連 traceIndex 一起驗
發生什麼: 外部 review 指出 `clear()` 只清 `traceIndex`;補測試時又發現沒有檔案的筆記卡,新增時 key 是 `'orphaned://trace'`,刪除和 relocate 時卻算成 `Uri.file('')`,殘留的項目會越積越多。兩個都修了,三個地方都改用 `fileIndexKey()`。
要記住的規則: 改動卡片的測試結尾要呼叫 `expectIndexConsistent(m)`(現在也驗 `traceIndex`);新測試要先把 bug 植入 source,確認測試會失敗,再還原。
證據: `npm test` → Test Files 10 passed / Tests 186 passed;把舊寫法放回 source,對應測試都會失敗。
