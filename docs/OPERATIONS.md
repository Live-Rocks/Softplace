# SoftPlace 維運手冊

## 環境與秘密

不得把 `.env`、API key、service-role、SMTP password、Worker secret、完整測試 UUID 或真實聊天 payload 寫入 Git、issue 或文件。

安全等級：

- **公開**：可進 Mobile bundle 或公開文件。
- **Server 設定**：不一定是 credential，但只由 server 控制。
- **秘密**：只能存在本機 server `.env`、Zeabur env、Supabase Vault 或供應商後台。
- **高敏感除錯**：會暴露聊天內容，預設必須關閉。

### Mobile `apps/mobile/.env`

| 變數 | 用途 | 等級 |
| --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | Express API base URL；staging 使用 Zeabur HTTPS，本機可用 Mac LAN IP | 公開 |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL | 公開 |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key；受 RLS 保護，不是 service-role | 公開 |

### Server `apps/server/.env`

| 變數 | 用途／預設 | 等級 |
| --- | --- | --- |
| `PORT` | Express port，本機預設 `8787`；Zeabur 注入 | Server 設定 |
| `APP_ORIGIN` | CORS origin，本機常用 `http://localhost:8081`；`*` 表示允許任意 origin | Server 設定 |
| `SUPABASE_URL` | Supabase project URL | Server 設定 |
| `SUPABASE_SERVICE_ROLE_KEY` | Auth 驗證與資料庫 privileged access | 秘密 |
| `AI_PROVIDER` | `openai` 或明確本機測試用 `local` | Server 設定 |
| `OPENAI_API_KEY` | OpenAI Responses／Embeddings API | 秘密 |
| `OPENAI_DEEP_MODEL` | 安放深度模型，預設 `gpt-5.4-mini` | Server 設定 |
| `OPENAI_LIGHT_MODEL` | 安放輕量模型，預設 `gpt-4o-mini` | Server 設定 |
| `OPENAI_LIFE_MODEL` | Ava 模型，預設 `gpt-5.4-mini` | Server 設定 |
| `OPENAI_STORE_RESPONSES` | 是否讓 OpenAI 保存 Response，預設 `false` | 隱私設定 |
| `OPENAI_DEBUG_IO` | 印出完整文字 instructions/input/output，預設 `false` | 高敏感除錯 |
| `OPENAI_TIMEOUT_MS` | OpenAI timeout，預設 `60000` | Server 設定 |
| `OPENAI_MAX_RETRIES` | SDK retry 次數，預設 `0` | Server 設定 |
| `CHAT_RATE_LIMIT_PER_MINUTE` | 每帳號分鐘限制，預設 `12` | Server 設定 |
| `CHAT_RATE_LIMIT_PER_HOUR` | 每帳號小時限制，預設 `120` | Server 設定 |
| `DEEP_RESERVATION_TTL_SECONDS` | 深度 reservation TTL，預設 `120` | Server 設定 |
| `RETRIEVAL_SHADOW_ENABLED` | Retrieval Shadow mode 開關，預設 `false` | Server 設定 |
| `RETRIEVAL_SHADOW_USER_IDS` | 逗號分隔 UUID allowlist；空值代表無人啟用 | 秘密／個資 |
| `RETRIEVAL_GENERATION_ENABLED` | Deep RAG canary 獨立開關；預設 `false`，開啟時要求 Shadow 同時開啟 | Server 設定 |
| `AVA_FEATURE_ENABLED` | Ava 全域開關，預設 `false` | Server 設定 |
| `AVA_BETA_USER_IDS` | 逗號分隔 allowlist；空值代表所有已登入帳號 | 秘密／個資 |
| `AVA_DAILY_LIMIT` | 每帳號 Ava 每日生成上限，預設 `30` | Server 設定 |
| `COMPANION_WORKER_SECRET` | 保護 `/internal/companion/tick` | 秘密 |

`OPENAI_STORE_RESPONSES=true` 與 `OPENAI_DEBUG_IO=true` 只可用虛構訊息短暫除錯；確認後立即改回 `false` 並重啟 server。

## Migration

新環境依序在 Supabase SQL Editor 執行：

1. `001_softplace_mvp.sql`：核心 enum、profile、聊天、記憶、用量、RLS。
2. `002_single_conversation.sql`：每位使用者單一主要時間線。
3. `003_remove_image_usage.sql`：移除獨立圖片用量。
4. `004_expand_memory_content.sql`：手動記憶改為 trim 後 1～300 字。
5. `005_production_hardening.sql`：Free 預設、rate limit、深度 reservation 與原子完成交易。
6. `006_fix_deep_usage_ambiguity.sql`：修正完成深度交易的 SQL 欄位歧義。
7. `007_ava_async_companion.sql`：Ava 關係、訊息、記憶、job、每日用量與 push token。
8. `008_ava_global_event_foundation.sql`：Ava 全域 2～3 天事件 run 與每日 phase 骨架；尚未改變 prompt。
9. `009_ava_event_daily_details.sql`：Ava 每日全域事件細節、原子 lease 與 30 分鐘失敗重試。
10. `010_message_sequence.sql`：安放訊息對話內流水號、原子分配 trigger 與可靠分頁排序。
11. `011_retrieval_shadow.sql`：pgvector、512 維 dialogue-window chunks、shadow jobs/runs/candidates、RLS 與受控 RPC。
12. `012_retrieval_generation_canary.sql`：Deep allowlist generation runs/candidates、雙層 review、token／latency 觀測、30 天清理與 service-role RPC。
13. `013_retrieval_generation_top5.sql`：保留 Top 2 基線，新增 `top5_all` strategy 與 Top 5 candidate 記錄約束。
14. `014_retrieval_generation_local_rerank.sql`：Generation Top 20 搜尋、selection rank／decision 與 `top20_local_rerank` 記錄。
15. `015_retrieval_user_evidence.sql`：chunk evidence embedding、user-only Generation 搜尋與 `user_evidence_top20` 記錄。
16. `016_retrieval_evidence_adaptive.sql`：`below_relevance` decision、`user_evidence_adaptive` 記錄 RPC 與既有 strategy 相容約束。
17. `017_retrieval_observability.sql`：長對話 bounded context RPC、`phase25_v1` 實際設定、可核對來源 manifest、完整 review 欄位與原子 observation RPC。

已執行的 migration 不回頭改寫；修正以新編號追加。執行前先讀 SQL，執行後保存結果並跑對應 smoke test。

## 本機啟動

首次或 dependency 不完整：

```bash
cd "/Users/a1/Downloads/2026/softplace"
nvm use system
npm ci
```

Server：

```bash
npm run dev:server
curl http://localhost:8787/health
```

Expo Go：

```bash
cd apps/mobile
npm run start -- --host lan --clear
```

若 Mobile 使用 Zeabur API，只需 Expo Metro 在本機；若使用本機 API，手機與 Mac 必須同網路，且 mobile env 使用 Mac 當下的 LAN IP。

## Zeabur 部署

GitHub repository 的 `main` 已連接 Zeabur。`git push` 後 Zeabur 依根目錄 `zbpack.json` 執行：

```bash
npm run build:server
npm run start:server
```

Zeabur 只啟動 Express，不啟動 Expo。環境變數由 Zeabur service 保存，`PORT` 由平台提供。

部署後：

```bash
curl -i https://softplace.zeabur.app/health
```

預期 HTTP `200`，body 包含 `{"ok":true,"service":"softplace-server"}`。

## Resend、SMTP 與 OTP

- 寄件網域：`softplace.online`。
- DNS provider 保存 Resend 提供的 DKIM、SPF/MX 與可選 DMARC records。
- Resend domain 必須顯示 verified。
- Supabase Auth 使用 Custom SMTP；SMTP password 只存在 Supabase 後台。
- Email template 必須顯示 `{{ .Token }}`，讓使用者回 App 輸入六位數 OTP，而不是只提供 magic link。
- App `signInWithOtp` 可建立新帳號；重寄使用既有 Email，並有 60 秒 UI cooldown。

修改 DNS、SMTP 或 template 後，以非管理員測試信箱走一次：寄碼、收信、輸入 OTP、建立 session、重開 App 保持登入。

## Companion Worker、Vault 與 Cron

Zeabur 的 `COMPANION_WORKER_SECRET` 與 Supabase Vault 的 `companion_worker_secret` 必須完全相同。

手動健康測試：

```bash
curl -X POST "https://softplace.zeabur.app/internal/companion/tick" \
  -H "Content-Type: application/json" \
  -H "x-companion-worker-secret: <secret>" \
  -d '{}'
```

空閒時預期：

```json
{"scheduled":0,"claimed":0,"completed":0,"retrieval":{"claimed":0,"completed":0,"failed":0}}
```

`retrieval` 統計與 Ava 獨立；只要 Shadow 開啟，同一 tick 即使 Ava 關閉仍會處理 Retrieval jobs 與 Generation retention cleanup。

Ava 事件的活動時間窗與準備／進行／結束後背景定義在 server 程式，不需要額外 migration。每日 `event_detail` 仍只生成一次，作為整日活動素材：活動開始前不送進回覆 prompt，活動進行中只用固定場景，活動結束後才可作為回顧。跨日收到訊息時只查詢既有 `companion_daily_states`；缺少歷史 row 時使用中性時段背景，不會由 Worker 補建過去日期。

Supabase 啟用 Cron、`pg_net` 與 Vault。Cron job：

- Name：`ava-companion-tick`
- Schedule：`* * * * *`
- Method：`POST`
- URL：`https://softplace.zeabur.app/internal/companion/tick`
- Body：`{}`
- Header：`Content-Type: application/json`
- Header：`x-companion-worker-secret`，從 Vault `companion_worker_secret` 讀取
- Timeout：`90000 ms`

檢查順序：Cron run status → `net._http_response` 的 `status_code/content` → Zeabur logs → `companion_jobs` 的 `status/due_at/last_error` → `companion_daily_usage`。

## Retrieval Shadow Mode

Shadow mode 只對 `RETRIEVAL_SHADOW_USER_IDS` allowlist 生效。合格文字會再次送到 OpenAI Embeddings API，固定使用 `text-embedding-3-small` 512 維；搜尋結果不會送進聊天生成模型或 Mobile API。正式 log 只能出現固定錯誤碼、ID、計數與耗時，不得出現聊天全文。

部署順序：

1. 套用 migration `011`，保持 `RETRIEVAL_SHADOW_ENABLED=false`。
2. Zeabur 設定 `RETRIEVAL_SHADOW_USER_IDS=<測試 UUID>`，確認 `COMPANION_WORKER_SECRET` 存在。
3. 先執行 dry-run，不會產生 embeddings：

```bash
npm run retrieval:shadow:backfill -- --user-id=<uuid>
```

4. 確認合格／跳過數量後才加 `--confirm`；此步會產生少量 OpenAI 費用：

```bash
npm run retrieval:shadow:backfill -- --user-id=<uuid> --confirm
```

5. 設定 `RETRIEVAL_SHADOW_ENABLED=true` 並重啟 server，手動呼叫一次 `/internal/companion/tick`。回應中的 `retrieval.claimed/completed/failed` 與 Ava 統計互相獨立。
6. 送一則 allowlist 純文字聊天，確認正常回覆沒有 retrieval 欄位；下一次 tick 後檢查 run 與 Top 5 candidates。圖片與危機訊息不得建立 job。

人工檢閱與脫敏報告：

```bash
npm run retrieval:shadow:review -- --user-id=<uuid> --limit=25
npm run retrieval:shadow:report -- --user-id=<uuid>
```

Review 指令會在本機終端臨時顯示實際 embedding 使用的最近兩則 user context、current query、Top 5 候選與 threshold 狀態，不會寫出含全文檔案。`--limit` 代表本次要新完成的 runs 數量；工具會分頁跳過已完整標註的 runs，並接續 partial run 尚未標註的 candidates。

Report 只輸出彙總數據至 gitignored `artifacts/retrieval-shadow/`。Phase 1 至少需要 50 個 completed runs 與 25 個完整 reviewed runs；shadow run/candidate 和已結束 job 保留 90 天，chunk 隨對話刪除。Phase 1.5 起，搜尋只接受結束於最早一則實際 recent user context 之前的 chunks，避免把 query 已帶入的最近對話重複召回；沒有合格 recent context 時才以 current query sequence 為上界。

## Retrieval Generation Canary

Phase 2 會把所有安放模型上下文從最近 20 則改為 10 則；只有最終模式仍為 Deep、無圖片、非危機且 UUID 位於 `RETRIEVAL_SHADOW_USER_IDS` 的請求，才可能同步注入較舊 user 原話。這些 allowlist 聊天會將搜尋命中的歷史文字再次送至 OpenAI Responses API；Mobile API 不回傳候選或分數。

Phase 2.2 Top 20 Local Evidence Rerank 部署順序：

1. 確認 migration `012_retrieval_generation_canary.sql` 已套用，並先設定 `RETRIEVAL_GENERATION_ENABLED=false`。
2. 部署 server，保持 Generation 關閉並確認 Light／Deep 正常。
3. 確認 migration `013_retrieval_generation_top5.sql` 已套用，再套用 `014_retrieval_generation_local_rerank.sql`；既有 rows 與人工標籤不重算。
4. 確認 `RETRIEVAL_SHADOW_ENABLED=true`、UUID allowlist 與既有 chunks 正常，再設定 `RETRIEVAL_GENERATION_ENABLED=true` 重啟 server。
5. 分別詢問貓咪名字與第一次出國地點；預期回答「飽飽」與「中國武漢」，run 應為 `selection_strategy=top20_local_rerank`、`candidate_count<=20`、`injected_count<=5`、`threshold=null`、`retrieval_tokens<=1200`。
6. 檢查固定的 embedding／search／source／total timeout error code 與 2.5 秒內 retrieval latency；聊天回覆 JSON 不得出現 retrieval metadata，並立刻以 review `--limit=1` 檢查選擇決策、實際注入與回覆。

任何 embedding／DB／來源載入錯誤或 2.5 秒逾時都 fail-open，以最近 10 則完成聊天。立即回退只需將 `RETRIEVAL_GENERATION_ENABLED=false` 並重啟；Shadow 可保持開啟。Generation run/candidate 保存 30 天，由每分鐘 worker 清理。

人工檢閱與報告：

```bash
npm run retrieval:generation:review -- --user-id=<uuid> --limit=10
npm run retrieval:generation:report -- --user-id=<uuid>
```

舊策略檢閱結果依 strategy 隔離保存；Phase 2.5 起 Review 預設只處理目前 `evaluation_version=phase25_v1`，舊資料須明確指定版本。工具在本機終端臨時 join 最近 10 則、本輪訊息、Top 20 原始候選、每個本機選擇決策、實際 user-only 注入與最終回覆；只要求替實際 injected candidates 標 `must/acceptable/forbidden/irrelevant`，回覆標 `helpful/neutral/harmful` 並回答 stale／sensitive。Report 依版本與實際設定分組並輸出排除原因、錯誤階段、平均注入數、latency 與 token；只寫脫敏彙總至 gitignored `artifacts/retrieval-generation/`。

### Phase 2.3 User-only Evidence Search

Phase 2.2 的 dialogue 向量排序和 user-only 注入不一致，造成舊 assistant 提過答案的 chunk 排在前面，但真正包含 user 事實的「飽飽」落到 Rank 19。Phase 2.3 不增加同步 API 呼叫；同一 chunk 額外保存 user-only evidence embedding，Generation 搜尋與注入都以 user 原話為依據，原本本機安全過濾仍保留。

部署與回填順序：

1. 保持 `RETRIEVAL_GENERATION_ENABLED=false`；Shadow 與 UUID allowlist 可維持開啟。
2. 先在 Supabase 套用 additive migration `015_retrieval_user_evidence.sql`。舊 server 不會使用新增欄位／RPC，因此此順序不影響聊天或 Shadow。
3. 部署新 server。先 dry-run，只顯示缺少 evidence embedding 的合格／跳過筆數，不輸出全文：

```bash
npm run retrieval:evidence:backfill -- --user-id=<uuid>
```

4. 確認數量後回填；這會把既有合格 user 原話送至 OpenAI Embeddings API，重跑只處理仍為 null 的 chunks：

```bash
npm run retrieval:evidence:backfill -- --user-id=<uuid> --confirm
```

5. 再執行一次 dry-run，預期 `eligible: 0`。確認 Zeabur `RETRIEVAL_GENERATION_ENABLED=true` 後重啟。
6. 不清除原本受污染測試資料，依序重測貓咪名字、第一次出國地點與哭泣地點。Run 應為 `selection_strategy=user_evidence_top20`、`search_strategy=user_only`、`candidate_count<=20`、`injected_count<=5`。正確證據應進入實際注入，而非只存在於未選 Rank 6～20。
7. Review 預設只處理 `user_evidence_top20`；完成 10 個 injected runs，沿用 helpful 至少 50%、timeout 不高於 10%，且 harmful／stale／sensitive／injected forbidden 全為 0 的 gate。舊 `top20_local_rerank` 結果不得混算。

新 Shadow jobs 會在同一次 embedding batch 建立 query、dialogue，並在存在可注入 user 事實時建立 evidence 向量；純探問／低資訊窗口的 evidence 為 null。Shadow 搜尋仍使用 dialogue 向量，Generation 才使用 evidence 向量。Migration 必須早於新 server 部署，否則 worker 尚找不到新的雙向量 upsert RPC。

### Phase 2.4 Adaptive Evidence Selection

Phase 2.3 已證明三個固定 facts 都能排到 Rank 1，但固定注入五個造成明顯無關內容。Phase 2.4 不改 embedding 或 Top 20 搜尋，也不增加 API 呼叫；只在本機套用：

- effective cutoff：`max(0.45, best eligible evidence score × 0.90)`。
- 與較高順位已選 chunk 共用任何 evidence message：整個候選排除，不讓無關半段繼承高分。
- 「回來了／嗯是呀／沒關係了」視為低資訊，不占注入名額。
- Evidence embedding 與注入共用同一分類器；純記憶探問／低資訊窗口不建立 evidence 向量，混合窗口只嵌入可注入的 user 事實。

部署順序：

1. 設定 `RETRIEVAL_GENERATION_ENABLED=false` 並等待重啟；Shadow 保持開啟。
2. Supabase 執行 `016_retrieval_evidence_adaptive.sql`。
3. 部署新 server並確認健康檢查。Generation 維持關閉，先預覽現有 chunks 的完整 refresh（不輸出全文）：

```bash
npm run retrieval:evidence:backfill -- --user-id=<uuid> --refresh
```

4. 確認數量後重算所有既有 evidence embeddings；純探問／低資訊窗口會被清為 null：

```bash
npm run retrieval:evidence:backfill -- --user-id=<uuid> --refresh --confirm
```

5. Refresh 完成後才將 Generation 改回 `true`。三個固定案例各自先隔開兩則普通 user context 再詢問。Run 應為 `selection_strategy=user_evidence_adaptive`；依目前實測分數，預期 `injected_count=1`，其他高重疊候選為 `duplicate`、弱候選為 `below_relevance`。
6. 若任何正確 Rank 1 未注入、回答使用無關候選或出現敏感／過時內容，立即關閉 Generation。
7. 完成 10 個新策略 injected runs 的 Review；沿用 helpful 至少 50%、timeout 不高於 10%，且 harmful／stale／sensitive／injected forbidden 全為 0 的 gate。

### Phase 2.4.1 Adaptive Cutoff 0.40

Phase 2.4 的 0.45 Canary 中，貓咪與武漢正確注入，哭泣證據以 Rank 1／`0.4300` 被安全擋下，固定案例為 2／3。Phase 2.4.1 將 effective cutoff 改為 `max(0.40, best eligible evidence score × 0.90)`；strategy 仍為 `user_evidence_adaptive`，新舊 runs 需依部署時間人工區分。

1. 設定 `RETRIEVAL_GENERATION_ENABLED=false` 並等待重啟。
2. 部署 server；本次沒有 migration，也不需 refresh embeddings。
3. 健康檢查通過後將 Generation 改回 `true`。
4. 以兩則普通 user 訊息隔開每題，重測貓咪、武漢、哭泣；預期正確 Rank 1、`injected_count=1`、無錯誤。
5. 另測一題 no-recall 與一題模糊回指，預期 `abstained`。若錯誤、敏感或過時證據被注入，立即關閉 Generation。
6. 繼續完成 10 個 `user_evidence_adaptive` reviewed injected runs；報告會混合 0.45／0.40，判讀時必須以部署時間辨識本輪資料。

### Phase 2.5 長對話與評估完整性

Phase 2.5 不改變搜尋與生成參數；仍是 `user_evidence_adaptive`、Top 20、`max(0.40, best × 0.90)`、最多五個候選、最近 10 則、1,200 tokens 與 2.5 秒。它把新版觀測標為 `evaluation_version=phase25_v1`，並以 manifest 保存來源 ID、順序、Unicode code-point 截斷長度及 hash，不另存聊天全文。

部署順序：

1. 保持單一知情 UUID allowlist，設定 `RETRIEVAL_GENERATION_ENABLED=false` 並等待 Zeabur 重啟；Shadow 可保持開啟。
2. 在 staging Supabase 執行 additive migration `017_retrieval_observability.sql`。舊 RPC 保留，尚未部署的新 server 不會使用新表與 RPC。
3. 部署新 server，確認 `/health`、一般 Light／Deep 與 Shadow tick 正常後，再將 Generation 改回 `true`。
4. 建立一筆 injected 與一筆 abstained，確認 run 的 `evaluation_version=phase25_v1`、manifest row 存在，且新版 review 能顯示 `verified` 的當時輸入。
5. 產生第一份新版 report；必須看到 `dataComplete=true`。若為 false，先修復缺筆或 retention 競態，不得把品質結果視為通過。

新版 Generation review 預設涵蓋 injected、abstained 與 fallback。第一步只顯示當時 history/query，先判斷是否需要最近 10 則以外的舊證據；第二步才顯示候選、已核對注入與回答：

```bash
npm run retrieval:generation:review -- --user-id=<uuid> --limit=10
npm run retrieval:generation:review -- --user-id=<uuid> --status=abstained --limit=5
npm run retrieval:generation:review -- --user-id=<uuid> --run-id=<run-uuid> --redo
```

`--status` 可用 `all|injected|abstained|fallback`；`--version` 預設 `phase25_v1`。`--from`／`--to` 必須含時區且採 `[from,to)`。`--run-id` 是單筆操作，不能搭配時間、status 或 limit；只有指定單筆才可使用 `--redo`。每一步立即保存，`Ctrl+C` 後可從 partial review 接續。查證正確來源時可輸入 message ID，或在終端以字串搜尋同 user／conversation 且早於 query 的歷史；全文不會寫進 artifact。

Report 也可限定 user、版本與時間；省略 user 時只產生匿名的多使用者分組，不能合成單一 Canary gate：

```bash
npm run retrieval:generation:report -- --user-id=<uuid>
npm run retrieval:generation:report -- --user-id=<uuid> --version=phase25_v1 \
  --from=2026-09-09T00:00:00+08:00 --to=2026-09-16T00:00:00+08:00
npm run retrieval:shadow:report -- --user-id=<uuid> \
  --from=2026-09-09T00:00:00+08:00 --to=2026-09-16T00:00:00+08:00
```

Phase 2.5 的工程驗證與品質驗收分開。樣本至少要有 10 筆 verified required、10 筆 not_needed，且至少 10 筆完整 reviewed injected，因此總數可能超過 20。報告會列 Known-evidence Hit@20、注入證據命中、選擇漏失、候選池外漏失、正確 abstention、不必要注入、timeout、token 與 latency；零分母顯示 `N/A`。既有 helpful ≥50%、timeout ≤10%、harmful／stale／sensitive／injected forbidden 全為 0 仍保留，但即使都通過也只顯示待人工 go/no-go。

本機可用 Docker 相容環境執行 migration 001～017 與 SQL integration fixtures：

```bash
npm run test:retrieval:sql
```

這項測試會建立臨時 pgvector PostgreSQL，驗證 3,000-message bounded RPC、ownership、RLS、原子寫入、idempotency、manifest、retention 與 cascade；不連正式 Supabase，也不呼叫 OpenAI。

## Expo Go 與未來 Preview APK

Expo Go 是開發容器，需從 Metro 下載 bundle；LAN 模式通常要求同一 Wi-Fi。Zeabur API 上線不會改變這件事。

Expo SDK 53 起，Android 的遠端 push 無法用 Expo Go 測試；SDK 54 的 SoftPlace 必須使用 development build 或 Preview APK。`apps/mobile/eas.json` 的 `preview` profile 會產出可直接安裝、無需 Metro 的 APK，並明確使用 EAS `preview` environment。

Mobile 已安裝 `expo-notifications`／`expo-constants`，登入後會建立 `ava-messages` Android channel、請求通知權限、取得 EAS project 對應的 Expo Push Token、呼叫 `/api/push-tokens` 註冊；點擊 `data.tab = "ava"` 的通知會開啟 Ava 分頁。設定頁的「Ava 推播」區塊會顯示註冊狀態與錯誤，並可手動重新檢查。

第一次建立 Android push：

1. EAS project 已連結為 `@aa5961311/softplace`；`app.json` 的 `extra.eas.projectId` 是 `92a8ce52-f523-4f5a-b259-126f0ed49369`。若更換 Expo 帳號或專案，才重新執行 `npx eas-cli login` 與 `npx eas-cli project:init`。
2. Firebase project 已建立為 `SoftPlace`（project ID `softplace-f9042`），Gemini 與 Google Analytics 關閉；Android app 已註冊為 `SoftPlace Android`，package 是 `online.softplace.app`。`google-services.json` 已放在 `apps/mobile/`，並在 `app.json` 的 `expo.android.googleServicesFile` 指向 `./google-services.json`。
3. Google Cloud／Firebase 的 FCM V1 service account JSON 已上傳並綁定 SoftPlace EAS project 的 `online.softplace.app`。這份本機檔案是秘密，不得放入 Git；若重新產生，仍須用 `npx eas-cli credentials --platform android` 更新 EAS credential。
4. EAS `preview` environment 已建立 `EXPO_PUBLIC_API_BASE_URL`、`EXPO_PUBLIC_SUPABASE_URL`、`EXPO_PUBLIC_SUPABASE_ANON_KEY`。這三項會進入 APK，屬公開 Mobile 設定，不得誤放 service-role 或 OpenAI key。
5. 執行 `npx eas-cli build --platform android --profile preview`，完成後從 EAS build 頁面的 install URL 在 Android 實機安裝 APK。`eas.json` 使用 remote app version source，preview profile 會自動遞增 build number；目前 Expo manifest 顯示版本為 `0.3.1`。2026-07-27 的首個成功 build 是 `81f8db28-51aa-4a0d-acfa-8f81bfc629f6`；本機歷史副本為 `artifacts/softplace-preview-0.3.0.apk`（此目錄已由 Git 忽略）。
6. 登入並允許通知。先用 Expo Push Notifications Tool 對新 token 做單則測試，再傳一則 Ava 訊息，等 Cron／Worker 完成後確認背景與關閉 App 狀態都能收到通知，點擊後進入 Ava。2026-07-27 首次 Android 實機驗收成功：設定顯示「Ava 推播：已註冊」，並收到包含 Ava 完整內文的第一則遠端推播。

檢查資料與故障順序：`push_tokens` 是否有該帳號 enabled token → Worker log 是否出現 `[ava:push]` → Expo push ticket／receipt → EAS FCM V1 credential → Android App 通知權限與省電限制。目前 sender 已檢查 Expo HTTP 與逐 token push ticket；延遲 receipt 查詢與收到 `DeviceNotRegistered` 後自動停用 token 仍需補強。

## Smoke Test

每次資料庫、Auth、部署或 AI routing 改動後至少檢查：

1. `/health` 回 `200`。
2. OTP 新寄送、驗證與既有 session。
3. 安放 light 與 deep 各一則；確認實際模式與用量。
4. 圖片一則；確認預覽立即清除、圖片不永久保存。
5. 記憶新增、修改、刪除及重開載入。
6. 清除／重開 App 後聊天歷史正常。
7. Ava user message 先 queued，Cron 到期後 completed，App 收到回覆。
8. Ava proactive、quiet hours、未讀與 daily usage。
9. Retrieval Shadow／Generation flags、allowlist、fallback 與 Mobile response 隱私邊界。
10. Logs 不含聊天全文、base64、push token 或 secret。

## Rollback

1. 若是 server deploy 問題，先在 Zeabur 回退到上一個成功 Git deployment，或 revert 對應 commit 再 push。
2. 若是新 feature，先用 env 關閉；Ava 可設 `AVA_FEATURE_ENABLED=false`。
3. 若 Companion Worker 異常，停用 `ava-companion-tick` Cron，避免 Ava 與 Retrieval 持續重試及產生成本。
4. 若 OpenAI 異常，保持 retry `0`；不要以 `AI_PROVIDER=local` 冒充正式 AI 回覆。
5. Migration 原則上不回滾刪資料；以追加修復 migration 恢復相容性。
6. Rollback 後重跑 `/health` 與最小 smoke test，再調查根因。

## 常見故障

### `Network request failed`

- 確認 mobile env 的 API URL；實機不能用 `localhost` 連 Mac。
- 若使用本機 API，執行 `ipconfig getifaddr en0` 重新確認 LAN IP。
- 確認 server 正在跑、port 正確、手機與 Mac 同網路。
- VPN、防火牆、訪客 Wi-Fi 或 AP isolation 可能阻擋 LAN。
- 若使用 Zeabur，先直接開 `/health` 區分 API 與 Expo 問題。

### LAN IP 自己改變

路由器 DHCP 可能在重新連線、隔天或網路切換後分配新 IP。更新 `EXPO_PUBLIC_API_BASE_URL` 並重啟 Metro；或固定使用 Zeabur HTTPS API。

### Expo SDK 不相容

Expo Go major 必須支援專案 SDK。先確認 `apps/mobile/package.json` 的 Expo 版本與手機 Expo Go；必要時升級專案或安裝相容 client，不能只重開 Metro。

### `Cannot find module`／`node_modules` 缺檔

依賴安裝可能被中斷或 local tree 損壞。從 repo 根目錄執行：

```bash
nvm use system
npm ci
```

不要逐一手動安裝缺少的 transitive package；`npm ci` 依 lockfile 重建較可靠。

### Cron `succeeded` 但 Ava 沒回

Cron succeeded 只代表 SQL command 執行。再看 HTTP response 是否 `200`、body 的 `claimed/completed`、job 是否尚未到 `due_at`、是否 failed／leased，以及 Zeabur Worker logs。

### Ava 顯示「尚未開放」

確認 `AVA_FEATURE_ENABLED=true`，且測試帳號 UUID 位於 `AVA_BETA_USER_IDS`。變更 Zeabur env 後需等待 service 重新啟動。
