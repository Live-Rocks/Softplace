# SoftPlace

SoftPlace 是一個私人的 AI 情緒陪伴 App。核心角色「安放」提供即時情緒承接；Ava 則是在同一個 App 內，測試具有生活節奏、延遲回覆與主動訊息的長期陪伴方式。

目前專案處於本人使用與少量封測前的 staging 階段，不是心理治療、診斷服務、公開社群或正式付費產品。最新完成度、限制與 roadmap 以 [專案狀態](docs/PROJECT_STATUS.md) 為準。

## 技術棧

- Mobile：Expo React Native、TypeScript、Supabase Auth
- API：Node.js 24、Express、TypeScript
- Data：Supabase Postgres、RLS、RPC、Vault、Cron
- AI：OpenAI Responses API、Embeddings API
- Deploy：GitHub repository、Zeabur
- Email：Resend SMTP、Supabase Passwordless Email OTP

## Monorepo

```text
apps/mobile/               Expo App
apps/server/               Express API、OpenAI 與 Worker
packages/shared/           Mobile／Server 共用型別
supabase/migrations/       001～016 資料庫 migration
docs/                      產品、架構、狀態、維運與決策文件
zbpack.json                Zeabur build／start 設定
```

## 本機設定

需求：Node.js `24.x`、npm `11.x`。

```bash
cd "/Users/a1/Downloads/2026/softplace"
nvm use system
npm ci
cp apps/server/.env.example apps/server/.env
cp apps/mobile/.env.example apps/mobile/.env
```

在 Supabase SQL Editor 依序執行 `supabase/migrations/001_*.sql` 到 `016_*.sql`。已執行的 migration 不回頭改寫；後續修正一律追加新編號。把實際 credential 填入兩份 `.env`；OpenAI key 與 Supabase service-role key 只能放在 server，不能放進 mobile。

## 啟動

Server：

```bash
cd "/Users/a1/Downloads/2026/softplace"
nvm use system
npm run dev:server
```

Mobile／Expo Go：

```bash
cd "/Users/a1/Downloads/2026/softplace/apps/mobile"
nvm use system
npm run start -- --host lan --clear
```

實機使用 Expo Go 時，`EXPO_PUBLIC_API_BASE_URL` 必須是 Zeabur HTTPS 網址，或同一區網內 Mac 的 LAN IP，不能使用手機自己的 `localhost`。

## 驗證

```bash
npm run typecheck
npm run test --workspace apps/mobile
npm test
npm run build:server
```

Retrieval／RAG 的虛構繁中離線評估需另外手動執行；這套離線工具不會進入一般測試或正式聊天。Runtime 的 Deep allowlist Canary 是另一條獨立流程：

```bash
npm run eval:retrieval
```

資料集、指標與 CLI 選項見 [Retrieval 離線評估](docs/RETRIEVAL_EVAL.md)。

Retrieval Shadow mode 的回填、人工檢閱與脫敏報告為管理指令，預設 feature flag 關閉：

```bash
npm run retrieval:shadow:backfill -- --user-id=<uuid>
npm run retrieval:evidence:backfill -- --user-id=<uuid>
npm run retrieval:shadow:review -- --user-id=<uuid> --limit=25
npm run retrieval:shadow:report
npm run retrieval:generation:review -- --user-id=<uuid> --limit=10
npm run retrieval:generation:report
```

部署與隱私邊界見 [Operations](docs/OPERATIONS.md#retrieval-shadow-mode)。

Production server：

```bash
npm run build:server
npm run start:server
curl https://softplace.zeabur.app/health
```

## 目前模型

- 安放輕量模式：`gpt-4o-mini`
- 安放深度模式：`gpt-5.4-mini`
- Ava：`gpt-5.4-mini`

模型名稱由 server 環境變數控制。OpenAI Responses 預設 `store:false`；安放每次只送最近 10 則訊息與已確認記憶。Deep allowlist Canary 以 user-only evidence 搜尋 Top 20，再套用 `max(0.40, best score × 0.90)`、重疊與安全過濾，最多注入 5 個候選，合計不超過 1,200 tokens。

## 文件索引

- [產品定義](docs/PRODUCT.md)：問題、使用者、產品信念與邊界
- [系統架構](docs/ARCHITECTURE.md)：服務責任、資料流、API 與資料所有權
- [專案狀態](docs/PROJECT_STATUS.md)：完成度、限制與 roadmap 的唯一來源
- [維運手冊](docs/OPERATIONS.md)：環境變數、部署、Cron、SMTP、故障排除與 rollback
- [技術決策](docs/DECISIONS.md)：現有架構選擇及其原因

功能行為改變時，請在同一個 commit 更新對應文件；部署流程改變時，同步更新 `docs/OPERATIONS.md`。
