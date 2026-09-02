# Retrieval 離線評估

這套工具只用於評估「安放是否能從較舊對話找回適當片段」。它不連接正式聊天 prompt、不讀取 Supabase，也不代表 production RAG 已啟用。

## 資料集

`apps/server/src/evals/retrieval/dataset.v2.ts` 包含 8 位虛構使用者、64 個 logical events 與 40 個繁中 query；v1 保留供舊基線追溯。每個 event 都有固定 `user → assistant → user` 合成來源，並產生三種 chunk：

- `event_summary`：事件摘要。
- `user_only`：只保留兩則 user 訊息。
- `dialogue_window`：保留完整三則訊息與角色標記。

每個 query 對同一使用者的 logical chunk 標記：

- `mustRetrieve`：缺少就會失去重要脈絡。
- `acceptable`：找到合理，但不是必要。
- `forbidden`：即使語意相似也不該帶回。
- 未列入三組的同使用者 chunk，在計分時視為 `irrelevant`。

所有資料必須保持 `source: synthetic`。敏感或危機 chunk 只能作為 `forbidden`，不能成為正向標籤。第一版有 8 題完全沒有 must／acceptable，用來測試系統能否在沒有適當舊脈絡時 abstain。

## 執行

需求：`apps/server/.env` 內有 `OPENAI_API_KEY`。一般 tests、typecheck 與 server runtime 不會執行 embedding eval。

```bash
npm run eval:retrieval
```

常用選項：

```bash
npm run eval:retrieval -- \
  --specs=text-embedding-3-small:512,text-embedding-3-small:1536,text-embedding-3-large:3072 \
  --chunk-strategies=event_summary,user_only,dialogue_window \
  --top-k=1,3,5 \
  --thresholds=0.50,0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90 \
  --batch-size=64
```

- `--ignore-cache`：忽略既有 embedding cache 並重新產生。
- `--output-dir=/absolute/path`：改變 artifact 輸出根目錄。
- `--specs=model:dimensions,...` 是 canonical 模型介面；舊 `--models`／`--dimensions` 仍可使用，但不能和 `--specs` 混用。

快取與報告都寫入 gitignored 的 `artifacts/retrieval-eval/`：

```text
artifacts/retrieval-eval/cache/<model>-<dimensions>.json
artifacts/retrieval-eval/reports/<timestamp>/report.json
artifacts/retrieval-eval/reports/<timestamp>/report.md
```

## 指標

- **Must hit rate @ K**：具有 must 標籤的題目中，Top K 至少命中一個 must 的比例。
- **Must recall @ K**：所有 must chunk 中實際進入 Top K 的比例。
- **Forbidden hit rate @ K**：Top K 至少出現一個 forbidden 的題目比例，越低越好。
- **Sensitive/crisis hit rate @ K**：Top K 至少帶回一個敏感或危機 chunk 的題目比例。
- **Irrelevant hit rate @ K**：所有回傳結果中，未被人工標註的 irrelevant chunk 比例。
- **Abstention accuracy**：no-recall 題目在 threshold 後完全不回傳結果的比例。

報告同時比較三種 chunk 與兩種 query 組法，也列出各 corpus 的平均字數、raw vector bytes 與 serialized vector bytes。Phase 0 recommendation 固定從 small 512＋最近 user context 中，以零 sensitive/crisis、零 forbidden 為前提挑選 Recall@3 最佳的 chunk；`candidateThreshold` 仍只是診斷值，不能直接當成 production threshold。

## Phase 0 決策（2026-08-13）

- 首選候選模型：`text-embedding-3-small`，512 維。
- Query：目前訊息加最近兩則 user context。
- Chunk winner：`dialogue_window`。
- 診斷 threshold：`0.60`；Recall@3 `59.4%`、Forbidden `0%`、Sensitive/Crisis `0%`、Irrelevant `4.8%`、Abstention `100%`。
- 相同 64 chunks 的 raw vector 大小為 128 KiB；1536 維為 384 KiB，符合約三分之一的預期。

這是 synthetic Phase 0 基線，不是 production threshold。下一階段需在 Shadow mode 記錄匿名化命中、分數與延遲後再校準。

## Phase 1 Shadow 基線（2026-08-14）

- 完成 `53` 個 runs、人工完整檢閱 `25` 個 runs／`125` 個 Top 5 candidates，worker error 為 `0`。
- 人工標籤為 must `19`、acceptable `37`、irrelevant `69`、forbidden `0`。
- Threshold `0.60`：selected precision `82.6%`、query useful-hit `52.0%`、forbidden rate `0%`，共選中 `23` 個 candidates。
- Queue latency P50／P95 為 `35,325／57,571 ms`；search latency P50／P95 為 `137／203 ms`。
- `0.60` 保留為後續候選門檻，不是 production 決策；`0.65` precision 僅升至 `85.7%`，useful-hit 降至 `44.0%`。
- 本批沒有任何人工 forbidden 樣本，因此只能說「未觀察到 forbidden retrieval」，不能推論敏感／危機風險已充分驗證。

完整 v1 JSON／Markdown 報告保留在 gitignored `artifacts/retrieval-shadow/2026-08-14T08-17-10-107Z/`，不進版控。Phase 1.5 起，搜尋會排除與實際 recent user context 時間範圍重疊的 chunks；v1 基線不重算、不覆寫，也不和修正後的新 runs 直接混合比較。

## Phase 2 Deep Generation Canary

- 所有安放生成只使用最近 10 則；Deep allowlist 才同步執行 generation retrieval。
- Phase 2 原始基線搜尋 Top 5、threshold `0.60`，最多注入 2 個 chunks；歷史 rows 標記為 `threshold_top2`。
- Embedding／搜尋使用 `dialogue_window`；實際 prompt 只放歷史 user 原話，不放舊 assistant 回覆，整段最多 1,200 tokens。
- Retrieval 最多等待 2 秒；錯誤、逾時與無合格候選都以最近 10 則正常生成。Shadow pipeline 繼續運作。
- 只記錄 ID、rank、score、是否注入、延遲、token 與人工標籤；Mobile API 與一般 log 不含候選或全文。
- 完成 25 個 injected runs 的候選＋回覆雙層檢閱後，要求 helpful 至少 50%，且 harmful、stale、sensitive、injected forbidden 全為 0。Token 節省只報告、不作硬門檻。

## Phase 2.1 Top 5 User-Only Canary

- 真實「貓咪名字」案例的正確原話位於 Rank 4／5、score 約 `0.49`；降低 threshold 只會先選中無關 Rank 1／2，因此不調低門檻。
- 新策略 `top5_all` 忽略 similarity threshold，將 Top 5 的 user 原話依 message ID 去重，在公平共用的 1,200-token 上限內交給同一次 Deep 生成；搜尋 embedding、最近 10 則與 2 秒上限不變。
- 不新增 reranker 呼叫。候選彼此視為可能無關，prompt 只能使用與本輪直接對應的原話，不得合併事件或憑低相關候選宣稱記得。
- Review/report 只以 `top5_all` 新 runs 計算 Phase 2.1 gate，並分別保留 `threshold_top2` 歷史基線、irrelevant injected 比例、平均 injected chunks 與 token 指標。
- 2026-08-15 初始 smoke test：首筆成功 run 注入 5／5 candidates，retrieval 為 172 tokens／823 ms，並從原本位於 Rank 4／5 的正確原話回答「飽飽」，證明 Top 5 能補足舊 Top 2 的這次 recall miss；同批另有一筆在 2,003 ms timeout 後安全 fallback。
- 目前僅完成 1／25 個 `top5_all` runs 的人工檢閱，尚不宣稱 Phase 2.1 通過，也不將尚待語意確認的 candidate label 分布寫入基線。
- Phase 2.1 原先預留額外 reranker 的方向；後續真實失敗同時包含 timeout 與重複探問污染，因此由下述 Phase 2.2 Top 20 本機 evidence rerank 取代，不增加線上模型呼叫。

## Phase 2.2 Top 20 Local Evidence Rerank

- 後續診斷顯示 `top5_all` 共 23 runs 有 8 次 timeout（34.8%），最近 5 次全數在 2 秒 fallback；相同訊息的 Shadow 搜尋仍正常完成，因此同步總上限先提高至 2.5 秒，並分開記錄 embedding／search／source timeout code。
- 「第一次出國」正確的「中國武漢」仍位於 Shadow Rank 1 或 Rank 5；「貓咪名字」則被多個只有「記得名字嗎」而沒有 user 答案的測試 chunks 擠出 Top 5。這表示除了 timeout，還存在 dialogue embedding 與 user-only 注入內容不一致造成的候選污染。
- 新策略 `top20_local_rerank` 不新增模型呼叫：先取 Top 20，再排除純記憶探問、固定低資訊、無效來源與重複 user 原話；保留原始向量順序並只注入最多 5 個合格候選，不足 5 個不補滿。
- Phase 2.2 真實固定測試未通過：哭泣地點正確；貓咪正解雖在 Top 20，卻因 dialogue embedding 與 user-only 注入不一致落在 Rank 19 而未選；第一次出國則在 2.5 秒的 embedding 階段 timeout。這三筆保留為不可覆寫的失敗基線。
- Phase 2.3 `user_evidence_top20` 為每個 logical chunk 增加 user-only evidence embedding，Generation 直接用它搜尋並注入同一批 user 原話；Shadow dialogue 基線不變。既有 chunks 需先回填，未有 evidence embedding 的資料不會進入新策略候選。
- Phase 2.3 實測讓「飽飽／中國武漢／旅遊巴士哭泣」全部升至 Rank 1，證明搜尋表示已對齊；但每筆固定注入五個 chunks，也把其他兩個測試 facts 與弱內容一起送入 prompt。相鄰 chunks 去除共享 message 後，剩餘半段還會錯誤繼承原 chunk 分數。
- Phase 2.4 `user_evidence_adaptive` 只選分數至少 `max(0.45, best evidence score × 0.90)` 的候選；與較高順位已選窗口共享任何 evidence message 時整個標為 duplicate，不再保留半段。三筆 production 排名離線重播都只留下正確 Rank 1。
- 每個候選保存原始 rank／score、selection rank 與固定 decision；Review 只要求標註實際 injected candidates，但會顯示完整候選池與排除原因。Report 與舊 `threshold_top2`／`top5_all` 完全分開。
- Phase 2.2 已因固定案例與 timeout gate 失敗，Phase 2.3 則因過度注入只保留為 recall 基線。Phase 2.4 需重新人工確認三個固定案例、完成 10 個 `user_evidence_adaptive` reviewed injected runs、helpful 至少 50%、timeout 不高於 10%，且 harmful／stale／sensitive／injected forbidden 全為 0；程式完成不代表 Canary 已通過。

## 修改資料集

新增或修改案例後先執行：

```bash
npm test
npm run typecheck
```

結構測試會檢查使用者／chunk／case ID、跨使用者引用、標籤重疊、no-recall 題數，以及敏感 chunk 是否誤標成正向結果。模型品質目前只產生人工報告，不作為 CI 硬門檻。
