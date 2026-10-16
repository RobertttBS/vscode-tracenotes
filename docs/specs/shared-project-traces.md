# Spec — 跨路徑共用同一專案的 Traces

- 狀態：已實作（`src/storage/`）
- 日期：2026-10-16

## 背景

目前 traces 依 **workspace 路徑** 儲存（`context.storageUri`，VS Code 以路徑 hash 分資料夾），且 `TracePoint.filePath` 存**絕對路徑**。因此同一專案放在不同路徑（`A/project1`、`B/project1`）時，各自的 traces 完全獨立。

## 使用情境

使用者同時處理同一專案的多個 issue，每個 issue 一個資料夾，各自放不同 branch / 版本的 source code：

```
issue1/  ← branch X 的 source
issue2/  ← branch Y 的 source
issue3/  ← branch Z 的 source
```

三個資料夾可能**同時開著**（多個 VS Code 視窗）查看；但**很少同時在兩個視窗寫入** trace。

## 需求

### R1 — 專案身分（Project ID）
同一專案的不同資料夾必須被識別為同一個專案。判斷優先序：
1. 使用者設定 `tracenotes.projectId`（workspace 設定，例如寫在各資料夾的 `.vscode/settings.json`）。
2. git remote `origin` 的 URL（正規化後：`git@host:a/b.git` 與 `https://host/a/b` 視為相同）。支援 `git worktree`（`.git` 為檔案）。
3. 開啟的資料夾名稱。

沒有開啟資料夾時，維持現有行為（`globalStorageUri`）。

### R2 — 共用 traces
同一 Project ID 下，在任一資料夾建立 / 修改 / 刪除 / 排序 trace、修改筆記、群組結構、顏色，其他資料夾都看得到同一份。

### R3 — 路徑可攜
trace 的檔案位置以**相對於 workspace root** 的路徑共用；在 issue2 點擊 issue1 建立的 trace，要開啟 **issue2 自己的檔案**，不能開回 issue1 的檔案。workspace 以外的檔案保留絕對路徑。

### R4 — 各 checkout 位置獨立
不同 branch 的程式碼不同，trace 的位置（`rangeOffset`、`lineRange`）、`orphaned` 狀態、因檔案搬移而重新定位的路徑，**每個資料夾各自維護**，互不覆寫。某 branch 沒有該段程式碼時，只在該資料夾顯示為 orphaned。

### R5 — 開著的視窗即時同步
另一個視窗寫入共用資料後，已開著的視窗應自動重新載入並更新側邊欄（不需重開 VS Code）。保留各視窗自己的 active tree / group 游標。

### R6 — 不可互相覆寫成無限迴圈
兩個不同 branch 的視窗同時開著時，自動重新定位（validation）不得觸發彼此不停重寫共用檔。

### R7 — 舊資料搬移
升級後第一次開啟某資料夾時，把該路徑原有的 traces 併入共用資料（以 tree id 去重），舊檔保留（改名，不刪除）。

## 可接受的限制（非需求）

- 兩個視窗在同一個存檔 debounce 視窗（約 2 秒）內都修改 trace：後寫者勝，另一邊的修改可能遺失。
- trace 的程式碼片段（`content`）是**建立當下**那個 branch 的版本。
- 多根目錄 workspace：只以第一個資料夾計算 Project ID 與相對路徑（與現有 Markdown 匯入/匯出一致）。
- fork 情境下 `origin` 不同時不會自動合併，需用 `tracenotes.projectId` 指定。

## 驗收

1. issue1、issue2 設定相同 projectId（或同 origin），在 issue1 新增 trace，約 2 秒內開著的 issue2 側邊欄出現該 trace。
2. 在 issue2 點擊該 trace，開啟的是 issue2 底下的檔案。
3. issue1、issue2 為不同 branch、同一檔案內容位移不同時，兩邊各自定位正確；兩個視窗閒置時共用檔不會持續被改寫。
4. 舊版資料在升級後仍可見。

## 設計（實作摘要）

**兩層儲存**（`src/storage/FileStorageManager.ts`）：

| 層 | 路徑 | 內容 | 誰寫 |
|---|---|---|---|
| 共用檔 | `globalStorageUri/projects/<sha1(projectId) 前 16 碼>/tracenotes.data.json` | trees，workspace 內路徑存為 posix 相對路徑（`pathMapping.ts`） | 只有使用者操作（`persist()`） |
| 位置檔 | `storageUri/tracenotes.positions.json` | `{ traceId: { rangeOffset, lineRange, orphaned } }` | validation、編輯位移（`persistPositions()`） |

- validation 只寫位置檔，所以 R6 的迴圈不會發生。
- 同目錄的 `project.json` 是 `{ id, folders[] }`，給 Set Project ID 的清單用。
- Project ID 解析在 `projectId.ts`：直接讀 `.git/config`，worktree 會跟著 `gitdir:` 與 `commondir` 找；不執行 git。結果寫在 Output「TraceNotes Storage」。
- 同步：FileSystemWatcher 監看共用檔，內容等於自己最後寫入或讀到的版本就忽略；有未存的修改（`isDirty`）時不重新載入，也就是後寫者勝。
- 搬移（R7）與 Merge 都用 `mergeTrees`：同 id 的 tree 若相同（忽略位置欄位、`createdAt`、`updatedAt`）或是空的就略過，否則換新 id 另存一份，名稱加上 ` (<資料夾名>)`。舊檔存檔成功後改名為 `.migrated`。

**介面**：側邊欄標題列的 `$(link)` 按鈕（命令 **TraceNotes: Set Project ID**）可以選現有專案、輸入新 ID，或恢復自動判斷。選好之後會問 **Merge / Switch Only**，寫入 WorkspaceFolder 設定，並用 `TraceManager.switchProject()` 立即切換。Merge 是複製，原專案的 traces 仍在。
