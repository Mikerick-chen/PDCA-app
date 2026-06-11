# PDCA Time Master

個人持續改善工具：每天以 Plan-Do-Check-Act 循環記錄，搭配行事曆月綜覽、日記、備忘錄、重要日期倒數、倒數計時器與專注時鐘。

技術棧：Node.js + Express + SQLite（後端）／Vanilla JS + HTML + CSS（前端，無框架）。實作依據見 `SPEC.md`。

## 本機啟動

```bash
npm install
npm start
# 開啟 http://localhost:3000
```

後端同時提供前端靜態檔，單一服務即可運作。資料庫檔預設建立於 `data/pdca.db`（初始為空，無 seed 資料）。

## 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | 3000 | 服務埠 |
| `DB_PATH` | `data/pdca.db` | SQLite 檔案路徑 |
| `JWT_SECRET` | （開發用預設） | JWT 簽章密鑰，正式環境務必設定 |
| `CORS_ORIGIN` | 全部允許 | 限制前端來源網域 |

## 部署到 Zeabur

1. 將此專案推到 Git 倉庫並於 Zeabur 匯入。
2. Zeabur 會依 `zeabur.json` 執行 `npm install` 與 `node server.js`。
3. 於環境變數設定 `JWT_SECRET`（必要），並建議掛載持久化磁碟給 `DB_PATH`。
4. 前端與後端為同一服務、同源呼叫 API，無需另設 API 網址。

## API 一覽

| 功能 | 端點 |
| --- | --- |
| 註冊 / 登入 | `POST /api/v1/auth/register`、`POST /api/v1/auth/login` |
| PDCA 初始化 / 更新 / 查詢 | `POST /api/v1/logs/init`、`PATCH /api/v1/logs/:id`、`GET /api/v1/logs/:id` |
| 行事曆月綜覽 | `GET /api/v1/users/:user_id/calendar?month=YYYY-MM` |
| 日記 | `GET/POST /api/v1/users/:user_id/diaries`、`PATCH/DELETE /api/v1/diaries/:id` |
| 備忘錄 | `GET/POST /api/v1/users/:user_id/memos`、`PATCH/DELETE /api/v1/memos/:id` |
| 重要日期 | `GET/POST /api/v1/users/:user_id/important-dates`、`PATCH/DELETE /api/v1/important-dates/:id` |
| 完成度統計 | `GET /api/v1/users/:user_id/stats?from=&to=` |

專注時鐘與倒數計時器為純前端功能，無對應 API。
