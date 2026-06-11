# PDCA Time Master — 系統規格書（SPEC.md）

> 版本：v1.3（日記改為每日可多篇；Check 圖表與行事曆/時鐘視覺定稿）
> 文件語言：繁體中文
> 規格層級用語遵循 RFC 2119：**MUST**（核心基石，絕對不可缺少）、**SHOULD**（強烈建議的最佳實踐）、**MAY**（選用功能）。
> ⚠️ 本文件僅為「規格書」，不包含任何實作程式碼。

---

## 0. 階段 0：專案參數與技術約束（凍結）

| 項目 | 設定值 | 說明 |
| --- | --- | --- |
| System_Mode | MVP（極簡模式） | 只關注核心 CRUD，完成 Plan-Do-Check-Act 四區塊閉環 |
| Creativity_Temperature | 0.4（平衡模式） | 穩定架構下規劃；**禁止**提議 LLM 自動覆盤等前沿功能 |
| Target_Platform | Web | 前端 Vanilla JS（無框架）；後端常駐於 Zeabur |
| 後端技術棧 | Node.js + Express + SQLite | 提供 RESTful API 服務 |
| 前端技術棧 | Vanilla JS / HTML / CSS | 前端**完全不儲存資料**，透過 Zeabur 固定網址呼叫 API |
| 註解與文件語言 | 繁體中文 | 所有程式碼註解與規格書**必須**使用繁體中文 |
| 初始資料庫狀態 | 空白 | **不可**放入任何 seed 或 demo 資料 |

**架構約束（MUST）**：任何偏離上述技術棧的架構皆不被允許。前端與後端透過 HTTP/JSON 溝通；前端不得使用 localStorage / IndexedDB 等做為「業務資料」來源（僅 MAY 用於暫存純 UI 狀態，例如目前選取日期、倒數計時器設定）。

---

## Step 1：產品功能與 UI/UX 流程規劃

### 1.1 產品定位

PDCA Time Master 是一套「以日為單位」的個人持續改善工具。使用者每天依 Plan → Do → Check → Act 的循環記錄，並透過行事曆綜覽整月狀態，輔以日記、備忘錄、重要日期倒數、倒數計時器與專注時鐘，形成可持續使用的個人成長系統。

### 1.2 全域版面（App Shell，MUST）

整體採「頂部列 ＋ 左側導覽 ＋ 主工作區」單頁式佈局，純 Vanilla JS 渲染，所有資料即時呼叫 API。

頂部列（由左至右）：

- App 名稱「PDCA Time Master」。
- **重要日期倒數區（MUST，第 6 點）**：標題右方常駐一個小型「倒數天數」膠囊，顯示最接近的重要日期（例如「距 期末考 還有 12 天」），點擊展開可新增/管理多個重要日期。
- 日期切換器：前一日 / 當日 / 後一日。
- 使用者頭像與登出。

左側導覽（MUST）：PDCA、行事曆、日記、備忘錄、登出。

### 1.3 PDCA 四區塊（MUST）

介面 **MUST** 包含 Plan、Do、Check、Act 四個獨立且具關聯性的輸入與展示區塊，四者共同隸屬「某一天的一筆 PDCA 日誌（PDCA_Daily_Log）」：

- **Plan（計畫）**：當日目標與預期產出，為其餘三區塊基準。
- **Do（執行）**：實際執行內容紀錄。
- **Check（檢核）**：對照 Plan 與 Do 的落差分析，並提供**完成數據視覺化圖表**（見 1.8）。
- **Act（行動）**：依 Check 結論提出的改善行動，作為下一循環輸入。

四區塊以四宮格呈現，Check 區 **SHOULD** 同步顯示 Plan 內容以利對照。每一格即一個可點擊的「按鍵區」，點擊後展開編輯（取代舊版底部時間軸的角色）。

### 1.4 行事曆（Calendar，MUST，取代原時間軸）

系統 **MUST** 提供「行事曆」頁，綜覽整個月份內容（**原「視覺化時間軸」功能正式更名為「行事曆」，不再另做每日時間軸**）：

- 以月為單位的格狀月曆，每一格代表一天。
- 每日格 **MUST** 標示當日是否有 PDCA 日誌、完成度（progress）、是否有日記，以及落在當天的重要日期。
- 點擊任一日 **SHOULD** 切換主工作區至該日的 PDCA 與日記。
- **MUST** 支援上一月 / 下一月切換。

### 1.5 日記（Diary，MUST，第 1 點）

提供獨立於 PDCA 的自由書寫日記：

- **每日可寫多篇**（同一天可有任意數量的日記條目），各篇支援標題、內文與心情標記（mood）。
- 與 PDCA 日誌**解耦**，可獨立使用；行事曆會標示哪些日子有日記（≥ 1 篇即標示）。

### 1.6 專注時鐘模式（Focus Clock，MUST，第 4 點）

PDCA 介面 **MUST** 提供一個小型時鐘入口，點擊後進入「全螢幕專注時鐘」：

- 全螢幕**純黑背景、僅置中顯示白色時間**（HH:MM 或 HH:MM:SS）。
- 適用手機全螢幕顯示；點畫面任一處或返回鍵即退出。
- 屬純前端功能，**不需**任何 API 或資料表。

### 1.7 倒數計時器（Countdown Timer，MUST，第 7 點）

主畫面下方 **MUST** 提供一個「時／分／秒」倒數計時器：

- 可設定時長、開始 / 暫停 / 重置，歸零時 **SHOULD** 給予提示（視覺閃動或音效）。
- 屬純前端元件，**不需** API；計時器預設值 **MAY** 以 localStorage 暫存（純 UI 狀態）。
- 與第 6 點「重要日期倒數天數」為兩個不同元件：前者是短時間倒數計時，後者是長天數倒數。

### 1.8 Check 完成數據視覺化（MUST，第 8 點）

Check 區 **MUST** 提供完成數據的視覺化圖表，提升回饋感：

- 以長條 / 折線圖呈現「近 N 日每日完成度（progress）」與「連續達成天數（streak）」。
- 資料來源為 `GET /stats`（見 API 8），由各日 `progress` 彙整。
- 圖表函式庫 **MAY** 使用輕量方案（如 Chart.js CDN），但前端整體仍維持無框架（Vanilla JS）。
- 進階遊戲化（虛擬寵物養成 / 讀書成就徽章）列為 **SHOULD（Sprint 2）**，資料結構預留（見 4.1）；MVP 先交付圖表。

### 1.9 內容溢出處理（Overflow，MUST，第 3 點）

當使用者輸入內容很多時，版面 **MUST NOT** 破版或被內容撐爆。強制規範：

- 每個 PDCA 區塊 **MUST** 設定最大高度並於內部自行捲動（`max-height` + `overflow-y: auto`），不得把外層撐高。
- 主工作區、行事曆、日記、備忘錄列表 **MUST** 各自有獨立捲動容器，彼此不互相推擠。
- 長字串（無空白的長連結等）**MUST** 啟用 `word-break` / `overflow-wrap` 避免水平破版。
- 頂部列與左側導覽 **MUST** 固定（sticky），不隨內容捲走。
- **驗收（MUST）**：以「每區塊貼入 5,000+ 字、20+ 筆備忘錄、單月每日皆有資料」測試，確認無破版、無水平捲動、無內容被裁切（見 4.3 溢出測試清單）。

### 1.10 降低輸入阻力（SHOULD）

介面 **SHOULD** 採用「組件化標籤」或「範本」降低輸入阻力（常用標籤 #會議 #開發 #閱讀 #運動；Plan/Act 提供一鍵範本）。資料表已預留 `tags` 欄位。

### 1.11 主要使用流程（Happy Path）

1. 註冊 / 登入 → 取得 token。
2. 開啟 App → 取得（或建立）當日 `PDCA_Daily_Log`。
3. 填寫 Plan/Do/Check/Act 並更新 `progress` → 儲存。
4. 需要專注時開啟全螢幕時鐘；做短倒數時用下方倒數計時器。
5. 於行事曆綜覽整月；於日記書寫當日心得。
6. Check 區查看完成度圖表，形成回饋閉環。

---

## Step 2：資料庫結構設計（Database Schema，SQLite）

系統 **MUST** 建立五大核心表：`Users`、`PDCA_Daily_Logs`、`Memos`、`Diaries`、`Important_Dates`。型態針對 SQLite 最佳化（動態型別，此處標示親和型別 affinity）。

> 設計說明：原 `Time_Blocks`（每日時間區塊）已隨「時間軸」功能移除，改由「行事曆月檢視」綜覽。短時間倒數計時器與專注時鐘為純前端功能，**不需**資料表。

### 2.1 Users（使用者）

身為 App 擁有者，需擷取每位使用者的 Gmail、姓名、帳號、密碼，做為日後更新通知與隱私保護之用。

| 欄位 | 型態 | 約束 | 說明 |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | 使用者主鍵 |
| `email` | TEXT | NOT NULL, UNIQUE | Gmail 信箱（日後更新通知聯絡管道） |
| `display_name` | TEXT | NOT NULL | 姓名 |
| `username` | TEXT | NOT NULL, UNIQUE | 登入帳號 |
| `password_hash` | TEXT | NOT NULL | 密碼雜湊值（**嚴禁**存明文） |
| `created_at` | TEXT | NOT NULL | 建立時間（ISO 8601, UTC） |
| `updated_at` | TEXT | NOT NULL | 最後更新時間（ISO 8601, UTC） |

安全約束：密碼 **MUST** 經單向雜湊（建議 `bcrypt` 含 salt）；資料庫與 API 回應 **MUST NOT** 回傳 `password_hash`；`email`、`username` **MUST** UNIQUE 做重複檢查；後端 **SHOULD** 驗證 email 格式與密碼最小長度（≥ 8 碼）。

### 2.2 PDCA_Daily_Logs（每日 PDCA 日誌）

| 欄位 | 型態 | 約束 | 說明 |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | 日誌主鍵 |
| `user_id` | INTEGER | **FK** → `Users(id)`, NOT NULL | 所屬使用者 |
| `log_date` | TEXT | NOT NULL | 日誌日期（`YYYY-MM-DD`） |
| `plan_content` | TEXT | NULL | Plan 區塊內容 |
| `do_content` | TEXT | NULL | Do 區塊內容 |
| `check_content` | TEXT | NULL | Check 區塊內容 |
| `act_content` | TEXT | NULL | Act 區塊內容 |
| `progress` | INTEGER | NOT NULL, DEFAULT 0, CHECK 0–100 | 當日完成度（%），供 Check 圖表使用 |
| `tags` | TEXT | NULL | 組件化標籤（JSON 字串陣列） |
| `created_at` | TEXT | NOT NULL | 建立時間（ISO 8601, UTC） |
| `updated_at` | TEXT | NOT NULL | 最後更新時間（ISO 8601, UTC） |

約束（MUST）：`FK` `user_id` → `Users(id)`，`ON DELETE CASCADE`；`(user_id, log_date)` 設 **UNIQUE**（每人每日一筆，支撐冪等初始化）。

### 2.3 Memos（備忘錄，類 Samsung Notes）

| 欄位 | 型態 | 約束 | 說明 |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | 備忘錄主鍵 |
| `user_id` | INTEGER | **FK** → `Users(id)`, NOT NULL | 所屬使用者 |
| `title` | TEXT | NULL | 備忘錄標題 |
| `content` | TEXT | NULL | 內文（純文字／Markdown） |
| `color` | TEXT | NULL | 便利貼色標（如 `#FFD54F`） |
| `is_pinned` | INTEGER | NOT NULL, DEFAULT 0 | 是否置頂（0/1） |
| `created_at` | TEXT | NOT NULL | 建立時間（ISO 8601, UTC） |
| `updated_at` | TEXT | NOT NULL | 最後更新時間（ISO 8601, UTC） |

約束：`FK` `user_id` → `Users(id)`，`ON DELETE CASCADE`；與 PDCA 日誌無耦合，可獨立交付。

### 2.4 Diaries（日記，第 1 點）

| 欄位 | 型態 | 約束 | 說明 |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | 日記主鍵 |
| `user_id` | INTEGER | **FK** → `Users(id)`, NOT NULL | 所屬使用者 |
| `entry_date` | TEXT | NOT NULL | 日記日期（`YYYY-MM-DD`） |
| `title` | TEXT | NULL | 標題 |
| `content` | TEXT | NULL | 內文 |
| `mood` | TEXT | NULL | 心情標記（如 happy / tired，或 emoji） |
| `created_at` | TEXT | NOT NULL | 建立時間（ISO 8601, UTC） |
| `updated_at` | TEXT | NOT NULL | 最後更新時間（ISO 8601, UTC） |

約束（MUST）：`FK` `user_id` → `Users(id)`，`ON DELETE CASCADE`。**不設** `(user_id, entry_date)` UNIQUE — 每人每日可建立多篇日記。

### 2.5 Important_Dates（重要日期 / 倒數天數，第 6 點）

| 欄位 | 型態 | 約束 | 說明 |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | 重要日期主鍵 |
| `user_id` | INTEGER | **FK** → `Users(id)`, NOT NULL | 所屬使用者 |
| `title` | TEXT | NOT NULL | 事件名稱（如「期末考」） |
| `target_date` | TEXT | NOT NULL | 目標日期（`YYYY-MM-DD`） |
| `color` | TEXT | NULL | 顯示色標 |
| `created_at` | TEXT | NOT NULL | 建立時間（ISO 8601, UTC） |

約束：`FK` `user_id` → `Users(id)`，`ON DELETE CASCADE`。剩餘天數於前端依 `target_date` 與當日計算，**不**入庫。

### 2.6 Index 建議（SHOULD）

- `idx_logs_user_date` on `PDCA_Daily_Logs(user_id, log_date)` — 行事曆月查詢與當日日誌。
- `idx_memos_user` on `Memos(user_id, is_pinned, updated_at)` — 備忘錄列表（置頂優先、最近更新）。
- `idx_diaries_user_date` on `Diaries(user_id, entry_date)` — 日記與行事曆標示。
- `idx_impdates_user_target` on `Important_Dates(user_id, target_date)` — 取最接近的重要日期。

> 啟用外鍵：SQLite 連線後 **MUST** 執行 `PRAGMA foreign_keys = ON;`。

### 2.7 實體關聯（ER 摘要）

```
Users (1) ───< (N) PDCA_Daily_Logs
Users (1) ───< (N) Memos
Users (1) ───< (N) Diaries
Users (1) ───< (N) Important_Dates
```

---

## Step 3：系統架構與 API 設計

### 3.1 架構總覽

```
[Browser: Vanilla JS / HTML / CSS]
        │  HTTPS / JSON
        ▼
[Zeabur 固定網址]
   └── Node.js + Express（REST API）
              └── SQLite（單檔資料庫，常駐 Zeabur）
```

前端為純靜態資源，**MUST** 透過 Zeabur 固定後端網址呼叫 API；API **SHOULD** 統一前綴 `/api/v1`、回傳 `application/json`；CORS **MUST** 允許前端來源。

### 3.2 統一錯誤回傳格式（SHOULD）

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "log_date 為必填且需為 YYYY-MM-DD 格式", "details": {} } }
```

成功一律包 `{ "success": true, "data": ... }`。HTTP 狀態碼：`200` 成功、`201` 建立、`400` 參數錯誤、`401` 未授權、`404` 找不到、`409` 衝突、`500` 伺服器錯誤。

### 3.3 核心 RESTful API（MUST）

> 以下每個 API 皆含 Endpoint、Method、Request Payload、Response 結構。Response 僅示意 `data` 內容（外層一律包 `{ "success": true, "data": ... }`）。

#### API 0a — 註冊（Register）

- **Endpoint / Method**：`POST /api/v1/auth/register`
- **Request**：
```json
{ "email": "user@gmail.com", "display_name": "王小明", "username": "ming123", "password": "至少 8 碼明文" }
```
- **Response（201，MUST NOT 含密碼）**：
```json
{ "id": 1, "email": "user@gmail.com", "display_name": "王小明", "username": "ming123", "created_at": "2026-06-09T00:00:00Z" }
```
- **錯誤**：`409`（email/username 已存在）、`400`（格式不符）。

#### API 0b — 登入（Login）

- **Endpoint / Method**：`POST /api/v1/auth/login`
- **Request**：`{ "username": "ming123", "password": "明文密碼" }`
- **Response（200）**：
```json
{ "token": "JWT 或 session token", "user": { "id": 1, "email": "user@gmail.com", "display_name": "王小明", "username": "ming123" } }
```
- **錯誤**：`401`。後續受保護 API **SHOULD** 帶 `Authorization: Bearer <token>`。

#### API 1 — 初始化／取得當日 PDCA 日誌

- **Endpoint / Method**：`POST /api/v1/logs/init`（冪等：當日存在則回傳既有）
- **Request**：`{ "user_id": 1, "log_date": "2026-06-09" }`
- **Response（200 既有 / 201 新建）**：
```json
{ "id": 10, "user_id": 1, "log_date": "2026-06-09", "plan_content": null, "do_content": null, "check_content": null, "act_content": null, "progress": 0, "tags": [], "created_at": "...", "updated_at": "..." }
```

#### API 2 — 更新 PDCA 四區塊內容與完成度

- **Endpoint / Method**：`PATCH /api/v1/logs/:id`（局部更新）
- **Request**（欄位皆選填，至少一項）：
```json
{ "plan_content": "完成 SPEC.md", "check_content": "三項完成兩項", "progress": 67, "tags": ["#開發", "#文件"] }
```
- **Response（200）**：回傳更新後完整日誌物件。
- **錯誤**：`404`、`400`（`progress` 超出 0–100）。

#### API 3 — 查詢單一日誌

- **Endpoint / Method**：`GET /api/v1/logs/:id`
- **Response（200）**：回傳該日誌完整欄位（plan/do/check/act/progress/tags）。
- **錯誤**：`404`。

#### API 4 — 行事曆月綜覽（取代原時間軸查詢，第 2 點）

- **Endpoint / Method**：`GET /api/v1/users/:user_id/calendar?month=YYYY-MM`
- **用途**：取整月每日摘要，供行事曆格狀渲染。
- **Response（200）**：
```json
{
  "month": "2026-06",
  "days": [
    { "date": "2026-06-09", "has_log": true, "progress": 67, "has_diary": true, "important_dates": [ { "id": 3, "title": "期末考", "color": "#E24B4A" } ] },
    { "date": "2026-06-10", "has_log": false, "progress": 0, "has_diary": false, "important_dates": [] }
  ]
}
```

#### API 5 — 日記 CRUD（第 1 點，每日可多篇）

- **取得某日多篇 / 列表**：`GET /api/v1/users/:user_id/diaries?date=YYYY-MM-DD` 回傳該日所有日記陣列（依 `created_at` 排序）；無 date 則回全部列表。
- **建立**：`POST /api/v1/users/:user_id/diaries`（每次新增一篇，不覆蓋既有）
```json
{ "entry_date": "2026-06-09", "title": "早晨", "content": "完成規格更新", "mood": "happy" }
```
回應 `201`，回傳新日記物件（含 `id`）。
- **更新**：`PATCH /api/v1/diaries/:id`（title/content/mood）→ 回傳更新後物件。
- **刪除**：`DELETE /api/v1/diaries/:id` → `{ "deleted_id": 7 }`。

#### API 6 — 備忘錄 CRUD（Memos）

- **列表**：`GET /api/v1/users/:user_id/memos`（置頂優先、依 `updated_at` 排序）。
- **建立**：`POST /api/v1/users/:user_id/memos`
```json
{ "title": "購物清單", "content": "牛奶、雞蛋", "color": "#FFD54F", "is_pinned": false }
```
- **更新**：`PATCH /api/v1/memos/:id`（title/content/color/is_pinned）。
- **刪除**：`DELETE /api/v1/memos/:id` → `{ "deleted_id": 5 }`。

#### API 7 — 重要日期 CRUD（倒數天數，第 6 點）

- **列表**：`GET /api/v1/users/:user_id/important-dates`（依 `target_date` 升冪，前端算剩餘天數）。
- **建立**：`POST /api/v1/users/:user_id/important-dates`
```json
{ "title": "期末考", "target_date": "2026-06-21", "color": "#E24B4A" }
```
- **更新 / 刪除**：`PATCH /api/v1/important-dates/:id`、`DELETE /api/v1/important-dates/:id`。

#### API 8 — 完成度統計（Check 圖表，第 8 點）

- **Endpoint / Method**：`GET /api/v1/users/:user_id/stats?from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Response（200）**：
```json
{
  "from": "2026-06-03", "to": "2026-06-09",
  "daily": [ { "date": "2026-06-08", "progress": 80 }, { "date": "2026-06-09", "progress": 67 } ],
  "streak": 5,
  "avg_progress": 73
}
```

> 第 4 點「全螢幕專注時鐘」與第 7 點「倒數計時器」為純前端功能，**無對應 API**。

### 3.4 API 與功能對應表

| 功能 | 對應 API |
| --- | --- |
| 註冊 / 登入 | API 0a / 0b |
| PDCA 初始化 / 更新 / 查詢 | API 1 / 2 / 3 |
| 行事曆月綜覽 | API 4 |
| 日記 | API 5 |
| 備忘錄 | API 6 |
| 重要日期倒數 | API 7 |
| Check 完成度圖表 | API 8 |
| 專注時鐘 / 倒數計時器 | 純前端，無 API |

---

## Step 4：階段性開發優先順序（Phased Development）

### 4.1 Sprint 劃分（MUST）

**Sprint 1 — MVP 必須最先交付**

後端 API（MUST）：API 0a、0b、1、2、3、4（行事曆）、5（日記）、6（備忘錄）、7（重要日期）、8（統計圖表）。

資料庫（MUST）：建立 `Users`、`PDCA_Daily_Logs`（含 `progress`）、`Memos`、`Diaries`、`Important_Dates` 五表、外鍵、`(user_id, log_date)` UNIQUE（日記每日可多篇，不設 UNIQUE）、建議索引。**不放入任何 seed/demo 資料。**

前端畫面（MUST）：
- 註冊 / 登入頁（API 0a/0b）。
- PDCA 四宮格頁（API 1/2/3），含 Check 完成度圖表（API 8）、小型時鐘入口、下方倒數計時器。
- 全螢幕專注時鐘（純黑底白字，純前端）。
- 行事曆月檢視頁（API 4）。
- 日記頁（API 5）。
- 備忘錄頁（API 6）。
- 頂部重要日期倒數膠囊與管理（API 7）。

非功能（MUST）：依 1.9 完整實作**內容溢出處理**並通過 4.3 溢出測試。

安全（MUST）：密碼 bcrypt 雜湊；受保護 API 驗證憑證；回應不含 `password_hash`。

部署（MUST）：後端常駐 Zeabur，前端以固定網址呼叫 API、設定 CORS。

**Sprint 2 — MVP 之後（不在本次交付範圍）**

- 遊戲化回饋：虛擬寵物養成 / 讀書成就徽章（SHOULD；依 `progress` 與 `streak` 驅動，資料結構預留）。
- 組件化標籤 / 範本 UI（SHOULD）。
- 日記與備忘錄進階：搜尋、心情統計、圖片附件。
- 倒數計時器音效自訂、重要日期通知提醒。

> 依 Creativity_Temperature 0.4 約束：**禁止**將 LLM 自動覆盤、AI 智慧建議等前沿功能納入任何 Sprint。

### 4.2 產品經理規格審查檢查清單（MUST）

**範圍與約束**
- [ ] System_Mode 維持 MVP；技術棧符合限制（Node.js + Express + SQLite；前端 Vanilla JS 無框架）。
- [ ] 前端完全不儲存業務資料；初始資料庫為空；文件與註解皆繁體中文。
- [ ] 無 LLM 自動覆盤等前沿功能被提議。

**帳號與安全**
- [ ] `Users` 含 email(Gmail)、姓名、帳號、密碼雜湊；密碼雜湊儲存且回應不含 `password_hash`；email/username UNIQUE。

**核心功能**
- [ ] PDCA 四宮格獨立且關聯，每格為可點擊按鍵區（已移除底部每日時間軸）。
- [ ] 行事曆月檢視可綜覽整月（原時間軸已更名為行事曆）。
- [ ] 日記功能（每日可多篇，獨立資料表）。
- [ ] 備忘錄 CRUD（標題/內文/色標/置頂）。
- [ ] 頂部重要日期倒數天數可新增/管理。
- [ ] 下方時／分／秒倒數計時器可用。
- [ ] 全螢幕專注時鐘（純黑底白字，純前端）。
- [ ] Check 區完成度圖表（資料來自 stats API）。

**資料庫（Step 2）**
- [ ] 五大核心表齊備，PK/FK/型態明確；UNIQUE 與索引已定義；外鍵與 CASCADE 已啟用。

**API（Step 3）**
- [ ] API 0a–8 齊備，各含 Endpoint/Method/Request/Response；統一錯誤格式已定義。
- [ ] 確認專注時鐘與倒數計時器為純前端、無 API。

**非功能：溢出（第 3 點，MUST）**
- [ ] 通過 4.3 溢出測試清單。

### 4.3 內容溢出測試清單（MUST，第 3 點）

- [ ] 每個 PDCA 區塊貼入 5,000+ 字 → 區塊內部捲動，外層不被撐高、不破版。
- [ ] 備忘錄建立 20+ 筆 → 列表獨立捲動，頂部列與導覽維持 sticky。
- [ ] 單月每日皆有 PDCA + 日記 → 行事曆格狀正常、無水平捲動。
- [ ] 貼入超長無空白字串 / 長網址 → 自動換行，不撐破水平版面。
- [ ] 手機窄螢幕（≤ 380px）→ 版面正常、可捲動、無內容裁切。

---

## 附錄 A：名詞對照

| 中文 | 英文 |
| --- | --- |
| 計畫 / 執行 / 檢核 / 行動 | Plan / Do / Check / Act |
| 每日日誌 | PDCA Daily Log |
| 行事曆 | Calendar |
| 日記 | Diary |
| 備忘錄 | Memo |
| 重要日期 / 倒數天數 | Important Date / Days Countdown |
| 倒數計時器 | Countdown Timer |
| 專注時鐘 | Focus Clock |
| 完成度 | Progress |
| 連續達成天數 | Streak |

---

## 附錄 B：v3 增補（依架構審查與凍結決策）

> 本附錄記錄 v3 相對 v2 的規格增補，使規格與實作同步。技術棧不變（Node.js + Express + node:sqlite + Vanilla JS）。

### B.1 資料持久化與部署（MUST）
- 資料庫 **MUST** 落在 Zeabur 持久卷：掛載 `/app/data`、設定 `DB_PATH=/app/data/pdca.db`、**Replicas 鎖為 1**（單檔 SQLite 不可多副本）。
- 後端 **MUST** 啟動時自動備份：每日以 `VACUUM INTO` 匯出帶日期副本至資料庫同層 `backups/`，保留最近 7 份。

### B.2 安全強化（MUST）
- `JWT_SECRET` **MUST** 以環境變數設定；未設或仍為原始碼預設值時，服務 **MUST** 啟動即 `process.exit(1)`（fail-fast）。
- 註冊／登入 **MUST** 先將 email 正規化 `trim().toLowerCase()` 再查詢/寫入（避免大小寫造成重複帳號或登入失敗）。
- `/api/v1/auth` **MUST** 套用速率限制（預設每 IP 15 分鐘 30 次，逾限回 `429`）；服務位於反向代理後 **MUST** 設定 `trust proxy`。
- 前端輸出 **MUST** 經 `esc()` 跳脫，且 `esc()` **MUST** 涵蓋 `& < > " ' \``。

### B.3 近即時同步與資料一致性（SHOULD）
- 前端 **SHOULD** 對 Check/Act 自動儲存（停打 1.5 秒 debounce + 失焦立即送、切換視圖/日期前 flush），右上角呈現單一儲存狀態，取代手動儲存按鈕。
- 前端 **SHOULD** 於 `visibilitychange`、`window focus` 與每 20 秒輪詢時，安靜就地重抓目前視圖（使用者正在輸入時跳過，不洗掉輸入）。
- `PATCH /items/:id`、`DELETE /items/:id`、`POST /logs/:id/items` 的回應 **SHOULD** 附帶該日誌最新 `plan_items` 與 `progress`，供前端就地更新（減少往返）；Do 勾選 **SHOULD** 採樂觀更新。
- `PATCH /logs/:id` **MAY** 支援樂觀鎖：請求帶 `updated_at`，與現況不符時回 `409`（`details.current` 附最新版），前端非破壞性重載；整體仍以「最後寫入者勝」為基準。

### B.4 待辦清單本質（MUST）
- 計畫項目（`Plan_Items`）**MUST** 僅屬當日，**MUST NOT** 實作任何「昨日 Act → 今日 Plan」之類的跨日自動帶入。
- 跨日彙整僅以唯讀面板呈現：週六/週日於 PDCA 下方顯示「本週 Act 回顧」，動態彙整當週週一~週五的 `act_content`。

### B.5 新增 API — 本週 Act 回顧
- **Endpoint / Method**：`GET /api/v1/users/:user_id/week-acts?date=YYYY-MM-DD`（`authRequired + sameUser`）。
- **用途**：取 `date` 所在週的週一~週五各日 `act_content`（以日期字串星期計算，時區安全）。
- **Response（200）**：
```json
{ "week_start": "2026-06-08",
  "days": [ { "date": "2026-06-08", "weekday": "一", "act_content": "…" }, … ] }
```

### B.6 日期驗證收嚴（MUST）
- `isValidDate` **MUST** 在格式正確的基礎上，再以 `parse 後 toISOString().slice(0,10)` 與原字串比對，擋掉 `2026-02-30` 這類不存在的日期（回 `400`）。

### B.7 UI 狀態：側欄收合（MAY）
- 左側導覽 **MAY** 提供收合切換（頂部列漢堡鈕），收合狀態以 localStorage 暫存（屬純 UI 狀態，符合第 0 節對 localStorage 的允許範圍），不影響任何業務資料。

---

**規格凍結聲明**：本 SPEC.md 為階段 1 產出，僅描述規格，未含實作程式碼。後續實作 **MUST** 以本文件為唯一依據，任何技術棧或範圍變更 **MUST** 先更新本文件並經產品經理審查。
