# 錨定演算法與 CLI 審查紀錄

- 審查日期：2026-11-12，基準 commit `6600fd6`（0.0.72）。
- 目的：列出 code→trace 錨定演算法與 CLI/bridge 的缺陷，供後續逐項修復。
- 用法：修完一項就勾選該項，並在該項下方補上 commit 與回歸測試名稱。
- 行號以基準 commit 為準。行號過期時，先用函式名稱重新定位。

狀態詞：**已驗證** = 審查時用暫存測試重現（測試檔已刪除，重現方法見各項）。**未驗證** = 僅由讀碼推得，修之前必須先寫測試重現。

## 總表

| 編號 | 摘要 | 狀態 | 後果 | 修復 |
|---|---|---|---|---|
| A1 | Tier B 用錯座標系選最近副本 | 已驗證 | 錯誤錨點，不標 orphaned | [ ] |
| A2 | 超過約 60 行的 trace 改一個識別字就 orphaned | 已驗證 | 誤判 orphaned | [ ] |
| A3 | 被刪除的區塊跳到同檔結構相似區塊 | 已驗證 | 錯誤錨點，不標 orphaned | [ ] |
| A4 | 短 trace 被編輯後跳到別處相同字串（含跨檔） | 已驗證 | 錯誤錨點，不標 orphaned | [ ] |
| A5 | Tier C 視窗起點落在字串內時復原失敗 | 已驗證 | 誤判 orphaned | [ ] |
| A6 | Tier C 同步阻塞 extension host | 已驗證 | 卡頓 0.6–2 秒 | [ ] |
| A7 | 尾端 token 被改時復原範圍縮短 | 已驗證 | 範圍少一段 | [ ] |
| A8 | 有 orphaned trace 時反覆掃整個 workspace | 未驗證 | 大量磁碟讀取 | [ ] |
| A9 | 編輯 B 檔會取消 A 檔的驗證且不重排 | 未驗證 | A 檔狀態過期 | [ ] |
| A10 | 跨檔搜尋沒有歧義保護 | 未驗證 | 錯誤檔案 | [ ] |
| C1 | CLI 寫入指令會切換使用者的 active tree | 已驗證（讀碼） | 面板跳走 | [ ] |
| C2 | `create`/`add` 用 `openTextDocument` 開每個檔案 | 未驗證 | didOpen 風暴 | [ ] |
| C3 | `check` 每個 orphaned trace 掃一次 workspace | 未驗證 | 可能超過 60 秒逾時 | [ ] |
| C4 | 找不到視窗時錯誤訊息的編輯器名稱不準 | 已驗證 | 訊息誤導 | [ ] |

建議順序：A1 → A2 → A3 → A5 → A7 → A8/C3 → A9 → A6 → A10 → A4 → C1 → C2 → C4。
A4 與 C1 涉及設計決策，動手前必須先與使用者確認。

## 重現用測試骨架

各項的「重現」都用下列方式呼叫私有方法。mock 寫法照抄 `src/recoverTracePoints.test.ts` 開頭。

```ts
const m = new TraceManager(contextMock) as any;
// 同檔，開啟歧義偵測（與 recoverTracePoints 的 Level 1 相同）
m.searchInText(fullText, storedContent, preferredOffset, undefined, true);
// 含跨檔 Level 2
await m.recoverTracePoints({ getText: () => fullText }, storedContent, preferredOffset, uri);
```

填充行產生器：

```ts
const filler = (n, tag, indent = '        ') =>
    Array.from({ length: n }, (_, i) => `${indent}${tag}_call_${i}(ctx, ${tag}_arg${i % 7});`).join('\n');
```

依專案規則，新測試必須先證明會失敗（修之前跑一次必須紅），修完才轉綠。

---

## 錨定演算法

背景事實：`TracePoint.content` 存的是 `dedent()` 後的文字。有縮排的多行 trace 在 Tier A（`findClosestExact`，逐字 `indexOf`）必定失敗。所以 Tier B（`findNormalized`）才是多行 trace 的主要復原路徑。

### A1. Tier B 用錯座標系選最近副本（已驗證）

- 位置：`findNormalized`，`src/traceManager.ts:1604`。
- 原因：`dist = Math.abs(idx - preferredOffset)`。`idx` 是正規化文字的座標，`preferredOffset` 是原文座標。該處註解說「兩邊等比例縮小」，實際只有 `idx` 縮小。
- 後果：縮排越深，偏差越大。演算法會選到檔案更後面的副本，且不觸發 `AMBIGUOUS_DUPLICATE`。
- 重現：
  - `stored = 'if (ready) {\n    start_engine(unit);\n}'`
  - 檔案：24 格縮排。`filler(150,'aa',ind)` + 區塊 + `filler(gap,'bb',ind)` + 區塊 + `filler(50,'cc',ind)`。
  - `preferredOffset` = 第一份區塊的 `if` 位置（第 151 行）。
  - 結果：`gap=40`、`70` 回傳 AMBIGUOUS；`gap=100`、`130`、`160` 回傳第二份（第 254、284、314 行）。
  - 期望：三種 gap 都回傳第 151 行。
- 修法：先把 `preferredOffset` 換算成正規化座標，再比距離。可以重用回推迴圈的邏輯，做一次正向掃描。`EXACT_PROXIMITY_CHARS` 的比較也必須在同一座標系內。

### A2. 長 trace 改一個識別字就 orphaned（已驗證）

- 位置：`fuzzyValidateBounds`，`src/traceManager.ts:1766-1775`。
- 原因：`budgetChars = floor(200000 / T) * 6`。trace 越長，`T` 越大，視窗越小。內容約 2000 字元以上時，視窗比內容本身短，完整比對不可能成立。
- 重現：
  - `stored` = `int big_function(struct dev *device)\n{\n` + n 行 `    status_i = handle_step_i(device, buffer_i, length);` + `\n    return 0;\n}`。
  - 檔案 = `filler(30,'pre','')` + 把中間一個 `handle_step_k(` 改成 `process_step_x(` 的 `stored` + `filler(30,'post','')`。
  - 結果：n=20（24 行）、n=40（44 行）復原成功；n=60、100、200 回傳 null。
  - 期望：全部復原。
- 修法：視窗不得小於內容長度加緩衝。DP 超過預算時改用 banded DP（只算對角線附近），或把內容切段，頭尾各自定位。
- 注意：`AVG_CHARS_PER_TOKEN = 6` 偏高。實測 C 程式碼含標點約 3–4 字元一個 token。

### A3. 被刪除的區塊跳到結構相似區塊（已驗證）

- 位置：`fuzzyValidateBounds` 的門檻（`src/traceManager.ts:1855`）與 `anchorThenSellers` 的候選產生（`src/traceManager.ts:1926`）。
- 原因有三項：
  1. 標點符號也算 token，佔一半以上，結構相同就先拿到大半分數。
  2. `T > 18` 時允許 40% 編輯距離。
  3. anchor 用子字串 `indexOf`，`ret` 會命中 `return`，候選點到處都是。
- 重現：
  - `stored = 'if (ret < 0) {\n    dev_err(dev, "failed to init: %d\\n", ret);\n    return ret;\n}'`
  - 檔案 = `filler(20,'aa','')` + 一行註解 + `filler(200,'bb','')` + `'if (err < 0) {\n    pr_warn(x, "other message", err);\n    return err;\n}'` + `filler(20,'cc','')`。
  - `preferredOffset = 500`。
  - 結果：回傳第 222–225 行的 `if (err < 0)` 區塊。
  - 期望：null（orphaned）。
  - 跨檔同一案例回傳 null，因為 `searchAcrossWorkspace` 的 anchor 預篩（40% anchor 必須出現）擋下了。
- 修法選項：
  - 距離只計識別字與字面值 token，標點只用來對齊。
  - 或加一道條件：目標的識別字集合中，至少一定比例必須逐字出現在命中範圍內。
  - anchor 比對改為整字比對（檢查前後字元不是識別字字元）。

### A4. 短 trace 被編輯後跳到別處相同字串（已驗證，需設計決策）

- 位置：`findClosestExact`，`src/traceManager.ts:1556`（唯一命中一律信任，不看距離）。`searchAcrossWorkspace`，`src/traceManager.ts:1740`（跨檔取第一個命中）。
- 根因：trace 的身分只有內容，沒有上下文。`handleTextDocumentChange` 已經精確追蹤到範圍，`validateDocumentTraces` 卻因內容不符而改做全檔搜尋。
- 重現：
  - `stored = 'mutex_lock(&dev->lock);'`
  - 檔案 = `'void a(void)\n{\n    mutex_lock(&dev->io_lock);\n}\n'` + `filler(400,'mid','')` + `'\nvoid z(void)\n{\n    mutex_lock(&dev->lock);\n}\n'`，`preferredOffset = 19`。
  - 結果：回傳第 407 行（另一個函式）。
  - 跨檔：原檔只留 `a()`，`other.c` 含 `mutex_lock(&dev->lock);`。結果：`filePath` 變成 `other.c`。
  - 期望：兩者都是 orphaned，或留在原位。
- 修法方向（必須先與使用者確認語意）：
  1. 變更完全落在 trace 範圍內時，信任即時追蹤的範圍，不做全檔搜尋。這會改變 orphaned 的定義。
  2. 擷取時多存前後各 N 行的指紋，用來驗證候選位置。這會改動 `TracePoint` 與持久化格式，依 `CLAUDE.md` 必須先提案。
  3. 最小改動：內容太短（例如 `T <= 10`）時，不信任超出 `EXACT_PROXIMITY_CHARS` 的唯一命中，也不做跨檔搬移。

### A5. Tier C 視窗起點落在字串內時復原失敗（已驗證）

- 位置：`tokenize`，`src/traceManager.ts:1875`。
- 原因：字串 regex `"(?:\\.|[^"\\])*"` 可以跨行。視窗從字串中間開始時，結尾引號被當成開頭引號，整個視窗的字串/程式碼判定反轉。
- 重現：
  - `stored` = `void report(void)\n{\n` + 12 行 `    log_event("step i done", value_i);` + `\n}`。把 `value_6` 改成 `other_x`。
  - 檔案 = `const char *banner = "` + `'x'.repeat(600 + pad*150)` + `";\n` + 修改後區塊 + `filler(10,'post','')`。
  - 結果：`pad=0` 成功；`pad=1`、`2`、`3` 回傳 null。
  - 對照組：把 banner 換成 `/* xxx… */`（900 字元），成功。
- 修法：`"` 與 `'` 字串不得跨行（字元類別排除 `\r\n`）。反引號字串維持可跨行。
- 未重現：Python `#` 註解內的撇號。測過一組，結果正常。

### A6. Tier C 同步阻塞 extension host（已驗證）

- 位置：`anchorThenSellers`，`src/traceManager.ts:1969` 的迴圈。`VALIDATION_BUDGET_MS` 只在 trace 之間檢查，迴圈內不檢查。
- 條件：anchor 是 `ret`、`dev`、`buf` 這類短而常見的字，且檔案很大。
- 重現：
  - `stored` = `int run(void)\n{\n` + 30 組 `    ret = fn(dev, buf, len);\n    if (ret) goto out;` + `\n}`。把第一個 `goto out;` 改成 `goto err;`。
  - 前後各放 N/2 行 `    ret = other_k(dev, buf, len + i);`。
  - 結果：5000 行（203 KB）171 ms；20000 行（815 KB）635 ms；60000 行（2.4 MB）1949 ms。
  - 對照：anchor 夠獨特時，2 MB 只要 17 ms。
- 放大因素：模糊復原成功後 `content` 不更新，之後每次驗證都會重跑一次 Tier C。
- 修法選項：DP 之前先做便宜的預篩（視窗內的 token 多重集合必須涵蓋目標的一定比例）；候選數設上限；anchor 改整字比對（同 A3）可以直接減少候選。

### A7. 尾端 token 被改時復原範圍縮短（已驗證，低嚴重度）

- 位置：`fuzzyValidateBounds`，`src/traceManager.ts:1844`。`dpCost[T] < bestDistance` 是嚴格小於，同分時取最早的結束位置，等於偏好「刪除目標尾端」而不是「取代」。
- 重現：`stored` 結尾 `return b + offset_value;\n}`，檔案改成 `return b + other_thing\n]`。結果範圍結束在 `return b +`。
- 修法：同分時取較晚的結束位置（改成 `<=`），或同分時比較範圍長度與目標長度的差。
- 影響小：結尾通常是 `}` 或 `;`，很少被改。

### A8. 有 orphaned trace 時反覆掃整個 workspace（未驗證）

- 位置：`handleTextDocumentChange`，`src/traceManager.ts:1125`（`needsValidation = tracesArr.some(t => t.orphaned)`）。`recoverTracePoints` → `searchAcrossWorkspace`，`src/traceManager.ts:1712`。
- 推論：檔案內有任一 orphaned trace 時，每次編輯停頓 500 ms 後、每次切分頁（`validateDocumentNow`）都會對每個 orphaned trace 執行一次 `findFiles('**/*.ext')` 並逐檔讀取。
- `findFiles` 的 exclude 傳 `undefined`。依 `@types/vscode` 文件，這只套用 `files.exclude`，不套用 `search.exclude`，所以 `node_modules`、建置輸出都會被讀。
- 沒有負面快取，也沒有跨 trace 共用已讀的檔案內容。
- 確認方法：mock `findFiles` 與 `fs.readFile` 計數，對含一個 orphaned trace 的檔案連續觸發兩次 `validateDocumentNow`，檢查讀檔次數。
- 修法選項：orphaned trace 的跨檔搜尋結果加快取（key = 內容雜湊，檔案系統有變動才失效）；編輯事件路徑不做 Level 2；一輪驗證內共用讀檔結果。

### A9. 編輯 B 檔會取消 A 檔的驗證且不重排（未驗證）

- 位置：`handleTextDocumentChange`，`src/traceManager.ts:1199`（取消是全域的）。`processValidationQueue`，`src/traceManager.ts:1245`（先 `delete(uri)` 再驗證）。
- 推論：A 檔驗證進行中（卡在 `await` 的跨檔搜尋），使用者在 B 檔打字。A 的驗證被取消，A 已不在 `pendingValidationDocs`。A 剩下的 trace 要等下次編輯 A 或切回 A 的分頁才會再驗證。
- 確認方法：測試中讓 `findFiles` 回傳一個可控的 promise，驗證 A 途中對 B 送一個變更事件，然後檢查 `pendingValidationDocs` 是否還有 A。
- 修法：驗證被取消時，把該文件（含 `nextIndex`）放回佇列。

### A10. 跨檔搜尋沒有歧義保護（未驗證）

- 位置：`searchAcrossWorkspace`，`src/traceManager.ts:1737-1740`。
- 推論：多個檔案都含相同內容（vendored 副本、建置輸出、備份目錄）時，回傳 `findFiles` 順序的第一個。同檔重複會 orphaned，跨檔重複卻直接選一個，標準不一致。
- 確認方法：mock 兩個檔案含相同內容，檢查結果是否固定取第一個。
- 修法：找到第一個命中後繼續掃，有第二個檔案也命中就回傳 null。會增加讀檔量，必須與 A8 的快取一起做。

---

## CLI 與 bridge

CLI 啟動實測約 60 ms（`tracenotes help`，Electron-as-node），不需要優化。以下都在 `src/bridge/server.ts`。

### C1. 寫入指令會切換使用者的 active tree（已驗證，讀碼；需設計決策）

- 位置：`activate()`（`src/bridge/server.ts:385`）與 `focusTreeOf()`（`src/bridge/server.ts:390`）。
- 受影響指令：`note`、`title`、`move`、`rm`、`refresh`、`check`、`add`、`rename`。目標不在 active tree 時，面板會跳到那棵 tree，而且不切回來。
- 附帶成本：`switchTree` 會觸發一次 `validateActiveTreeBackground()`（`src/traceManager.ts:480`）。`check` 之後又呼叫一次，前一次被取消。
- 修法選項：
  1. 指令結束後切回原本的 tree 與 group。最小改動，但面板會閃一下。
  2. 讓 TraceManager 的 id 查詢與變更方法接受 tree id，不依賴 active tree。改動較大，涉及索引（只涵蓋 active tree），依 `CLAUDE.md` 必須先提案。

### C2. `create`/`add` 用 `openTextDocument` 開每個檔案（未驗證）

- 位置：`parseMarkdown` 呼叫 `validateAndRecover(trace)` 時 `background` 預設為 `false`（`src/traceManager.ts:2218`）。`withWarnings`（`src/bridge/server.ts:408`）每個 trace 再開一次。
- 推論：建立跨 40 個檔案的 tree 會開 40 個 `TextDocument`，每個都會對語言伺服器送 didOpen。
- 確認方法：在真實視窗跑一次大型 `create`，觀察語言伺服器輸出；或在測試中計數 `openTextDocument`。
- 修法：匯入路徑改用 `background=true`（`getDocAdapter` 的讀檔 adapter）。注意 `decodeFileContent` 只看 `files.encoding`，不做編碼自動偵測，行為會與 `openTextDocument` 略有不同。

### C3. `check` 每個 orphaned trace 掃一次 workspace（未驗證）

- 與 A8 同源。`check` → `validateActiveTreeBackground` → 每個 orphaned trace 一次 `searchAcrossWorkspace`。
- CLI 逾時是 60 秒（`src/cli.ts:31`）。逾時後 CLI 報錯，但視窗端仍繼續執行。
- 修掉 A8 後重新評估。

### C4. 找不到視窗時錯誤訊息的編輯器名稱不準（已驗證）

- 位置：`src/cli.ts:50`。`TRACENOTES_HOST` 為空時一律顯示「VS Code」。
- 實測：通用 shim 目前指向 Antigravity IDE 的執行檔，錯誤訊息仍寫「No VS Code window…」。
- 修法：host 為空時改用中性字眼（例如「editor」）。

### 已檢查、無問題

- CLI 啟動時間：60 ms。
- `request()` 的回應解析與 stale entry 清理邏輯。
- `handleTextDocumentChange` 的多變更處理：變更由右到左處理，二分搜尋的分割條件在位移後仍成立。
