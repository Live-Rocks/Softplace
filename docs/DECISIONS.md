# SoftPlace 技術決策

本文件使用簡化 ADR（Architecture Decision Record）。已接受的決策保留當時原因；未來方向改變時新增 ADR，不覆寫舊決策。

## ADR-001：由 Supabase 保存敏感對話

- 日期：2026-06-28
- 狀態：Accepted
- 背景：產品需要重開 App、server 重啟與跨分頁後仍能延續對話，同時讓使用者可刪除資料。
- 決定：安放與 Ava 對話以 Supabase Postgres 為資料來源，不依賴模型供應商保存會話。
- 影響：資料生命週期與刪除權由 SoftPlace 控制；server 必須承擔 RLS、service-role、migration 與隱私維運責任。

## ADR-002：OpenAI Responses 預設 `store:false`

- 日期：2026-06-28
- 狀態：Accepted
- 背景：情緒陪伴內容高度私人，產品不需要 OpenAI Conversations 保存狀態。
- 決定：所有 Responses request 預設 `store:false`，由 Supabase 提供歷史；使用 hashed `safety_identifier`。
- 影響：OpenAI Platform Logs 預設不提供完整可展開 Response；除錯時只能以虛構內容短暫開啟 store/debug，完成後關閉。

## ADR-003：單一時間線與最近 20 則上下文

- 日期：2026-07-09
- 狀態：Accepted
- 背景：MVP 需要連續感，但不應每次把全部歷史塞給模型，也尚未證明摘要或 RAG 的必要性。
- 決定：每位使用者維持一條安放時間線；UI 可分頁載入完整歷史，OpenAI 每次只收到最近 20 則與已確認記憶。
- 影響：成本與上下文大小可控；很長以前的具體細節可能無法被回想。摘要、embedding 與 RAG 延後到實測出現明確需求。

## ADR-004：輕量與深度是注意力深度，不是溫度高低

- 日期：2026-07-19
- 狀態：Accepted
- 背景：共用長 prompt 讓兩種模式互相污染，切回輕量後仍容易延續深度篇幅。
- 決定：保留共同的自然、溫柔人格，但每次只注入實際模式規則。輕量預設 `gpt-4o-mini`；深度預設 `gpt-5.4-mini`。
- 影響：模式與模型、prompt、額度一同路由；差異是強提示而非硬性句數保證，仍需用真實對話持續校準。

## ADR-005：圖片共用深度額度

- 日期：2026-07-19
- 狀態：Accepted
- 背景：獨立圖片額度增加資料表、API 與 UI 複雜度，且圖片本質上已使用深度模型。
- 決定：取消 `image_messages_used`。Plus／Pro 圖片成功只扣一次深度額度；Free 不開放圖片；資料庫只保留 `image_present`。
- 影響：用量顯示與扣款較直覺；圖片沒有獨立統計。原圖仍不永久保存。

## ADR-006：使用 Passwordless Email OTP

- 日期：2026-07-19
- 狀態：Accepted
- 背景：少量封測需要比 Email／密碼更單純的第一次操作，Expo Go 又不適合先做複雜 OAuth redirect。
- 決定：Supabase Auth 搭配 Resend custom SMTP，寄送六位數 Email OTP；App 提供 60 秒重寄 cooldown 與 single-flight request lock。
- 影響：不需管理密碼；仍依賴 Email 可達性、SMTP reputation 與 Supabase Auth rate limit。第三方登入延後。

## ADR-007：深度額度採原子 reservation

- 日期：2026-07-19
- 狀態：Accepted
- 背景：read-modify-write 在並行深度請求下可能超用或少扣，provider 失敗也不能收費。
- 決定：OpenAI 前建立有 TTL 的 reservation；成功由 `complete_chat_success` 同一交易保存 user／assistant 並正式扣款，失敗則 release。
- 影響：一致性提高，但加入 RPC、reservation cleanup 與 migration 維護成本。文字可在 reserve 失敗時回退 light，圖片不可。

## ADR-008：Ava 使用非同步 Worker

- 日期：2026-07-22
- 狀態：Accepted
- 背景：Ava 必須有非立即回覆與主動訊息，不能讓 Mobile request 等待數分鐘，也不能依賴 App 一直開著。
- 決定：使用 Supabase `companion_jobs`、原子 enqueue／claim／complete RPC、每分鐘 Cron 與 Zeabur Worker endpoint。
- 影響：App 送訊息後收到 `202`，再以輪詢取得結果；需處理 lease、重試、每日額度與 Cron 維運。Push 尚未完成。
- 後續（2026-07-27）：Expo push sender、Mobile Push Token 註冊與 Android 實機遠端推播鏈路已完成；輪詢仍保留為前景狀態同步與 fallback。上述「Push 尚未完成」只描述 ADR 通過當時的狀態。

## ADR-009：Ava 生活固定以台北時間運行

- 日期：2026-07-22
- 狀態：Accepted
- 背景：生活節奏需要可預測、可測試，且目前產品主要面向台灣。
- 決定：Ava 以 `Asia/Taipei` 選擇每日生活與分時活動；同一天所有使用者共享同一生活日。OpenAI 只收到收到訊息時與目前的短情境。
- 影響：重啟與部署不改變當日生活，token 增量有限；不同時區使用者仍面對台北作息，完整生活也不是每人獨立生成。

## ADR-010：Ava 是同一 App 的第二條 beta 實驗線

- 日期：2026-07-22
- 狀態：Accepted
- 背景：非即時朋友、文字寵物與多角色都有潛力，但立即拆成新 App 會重複 Auth、部署、資料與設計成本，也會模糊尚未驗證的需求。
- 決定：Ava 先放在 SoftPlace 內，與安放使用不同資料表、API、prompt 與互動節奏；安放仍是產品核心。
- 影響：可以共用帳號與基礎設施並快速比較兩種陪伴；導航與設定複雜度增加。是否拆分 App、加入寵物或擴充角色，待實測後另立 ADR。

## ADR-011：Ava 句子泡泡只做顯示層切分

- 日期：2026-07-22
- 狀態：Accepted
- 背景：單一完整泡泡容易像小文章，但將模型輸出改成多訊息格式會影響 API、資料庫、未讀與推播。
- 決定：資料庫仍保存一筆完整 assistant 文字；Mobile 依中文句末標點與空白行切成最多 3 個視覺泡泡，同時顯示。
- 影響：不改資料契約即可改善閱讀節奏，歷史與新訊息一致；它不模擬逐則送達，切句仍可能需要依實機案例調整。

## ADR-012：安放訊息以對話內流水號排序

- 日期：2026-07-27
- 狀態：Accepted
- 背景：一般聊天會在同一個資料庫 transaction 內寫入 user 與 assistant 訊息，兩者可能取得相同 `created_at`；以 UUID 作同時間排序會造成重開後順序不穩定。
- 決定：`messages` 由資料庫 trigger 分配每個 conversation 內連續的 `message_sequence`；歷史讀取、分頁 cursor 與模型最近 20 則上下文均以此排序。既有訊息維持 legacy 序號 `0`，不回填或重排。
- 影響：新訊息的因果順序可被保證；舊歷史保留原貌，測試資料可透過清除對話建立新的正確時間線。

## ADR-013：登入不設定年齡門檻

- 日期：2026-08-07
- 狀態：Accepted
- 背景：SoftPlace 的實際功能是一般情緒陪伴，原本的年齡確認會造成不必要的限制，也容易讓使用者對內容性質產生錯誤期待。
- 決定：移除登入頁的年齡確認與相關文案，Email OTP 登入只需有效 Email；產品仍保留心理治療、診斷與危機救援的既有邊界。
- 影響：產品定位與實際內容一致，更多使用者可以進入；未來設計文案與功能時，不以年齡限制取代清楚的安全與資料控制說明。

## ADR-014：最近 10 則作短期上下文，Deep Canary 以 RAG 補充舊脈絡

- 日期：2026-08-14
- 狀態：Accepted
- 背景：最近 20 則能維持連續感，但加入 retrieval 後若仍完整保留會增加 token 與重複內容；Shadow 基線已證明部分較舊片段可被找回，但尚未證明直接注入的生成品質。
- 決定：ADR-003 的模型上下文數量由 20 改為 10 則，Light 與 Deep 都適用。只有 Deep allowlist canary 在同步搜尋成功時，額外注入最多 2 個 threshold `0.60` 的 user-only 舊片段；搜尋仍使用 dialogue window。Generation 有獨立 kill switch，沿用 Shadow UUID allowlist。
- 影響：短期上下文成本下降，Light／Deep 的上下文能力更明確分流；Deep 增加最多 2 秒 retrieval 等待與錯誤召回風險，因此必須 fail-open、保留人工雙層檢閱，且通過 25 個注入回覆前不得擴大。

## ADR-015：Deep Canary 將 Top 5 user-only 候選交給同一次生成判斷

- 日期：2026-08-15
- 狀態：Accepted
- 背景：真實 Canary 的「貓咪名字」案例中，正確原話已存在於索引並位於 Rank 4／5，但 `0.60`／Top 2 策略 abstain；降低 threshold 只會先注入 Rank 1／2 的無關內容。
- 決定：僅對知情 allowlist Deep Canary，忽略 similarity threshold，將 Top 5 的 user 原話全域去重並在 1,200-token 公平上限內交給既有生成模型；不增加 reranker API 呼叫。舊 assistant 回覆、圖片與危機內容仍不注入。
- 影響：提高 Top 5 內正確細節可被使用的機會，但也增加無關、過時或敏感候選進 prompt 的風險；新舊 runs 必須以 strategy 分開檢閱，出現 harmful／stale／sensitive／forbidden 時立即關閉 Generation。

## ADR-016：Top 20 本機 Evidence Rerank 與 2.5 秒同步上限

- 日期：2026-09-01
- 狀態：Accepted
- 背景：`top5_all` 共 23 個 runs 中有 8 次逾時，最近 5 次皆在 2 秒觸發 fallback；非同步 Shadow 仍能找到「中國武漢」，但反覆的「記得貓咪名字嗎」測試 chunks 會擠掉真正包含「飽飽」的 user 原話。Dialogue embedding 可能受舊 assistant 回覆影響，實際注入卻只允許 user 原話。
- 決定：同步上限提高至 2.5 秒；Generation 專用搜尋取 Top 20，再以不增加 API 呼叫的本機規則排除純記憶探問、固定低資訊與重複 user 內容，依原始向量 rank 注入最多 5 個合格候選。舊 assistant、圖片與危機內容仍不得注入。
- 影響：預期提高事實 recall 並降低重複問句污染，但規則式分類仍可能漏掉特殊表達，因此以 `top20_local_rerank` 獨立觀測 10 個 reviewed injected runs；逾時率高於 10% 或出現任何 harmful／stale／sensitive／forbidden 時不得擴大 Canary。
