export type AvaConversationEvalCase = {
  id: string;
  category: "specific-follow-up" | "daily-life" | "emotional" | "proactive";
  history: Array<{ role: "user" | "assistant"; content: string }>;
  latestUser?: string;
  expected: string;
};

export const avaConversationEvalCases: readonly AvaConversationEvalCase[] = [
  { id: "cards-content", category: "specific-follow-up", history: [{ role: "assistant", content: "我整理了幾張參考卡片。" }], latestUser: "那些卡片記錄了什麼？", expected: "直接列出保存的卡片內容" },
  { id: "three-tasks", category: "specific-follow-up", history: [{ role: "assistant", content: "我先排了三件要做的事。" }], latestUser: "是哪三件？", expected: "直接說明三件事" },
  { id: "proposal-topic", category: "specific-follow-up", history: [{ role: "assistant", content: "今天在整理提案。" }], latestUser: "是什麼提案？", expected: "用事件 facts 回答提案主題" },
  { id: "photo-purpose", category: "specific-follow-up", history: [{ role: "assistant", content: "照片順序終於排好了。" }], latestUser: "那些照片要用在哪裡？", expected: "回答已保存用途或承認尚未確立" },
  { id: "book-title", category: "specific-follow-up", history: [{ role: "assistant", content: "在書店翻到一本有趣的雜誌。" }], latestUser: "是什麼類型的雜誌？", expected: "直接回答保存的刊物類型" },
  { id: "menu-choice", category: "daily-life", history: [{ role: "assistant", content: "今天在看一份早餐店菜單的版面。" }], latestUser: "菜單裡哪個排版最有趣？", expected: "表達具體偏好，不補人生感悟" },
  { id: "cooking-result", category: "daily-life", history: [{ role: "assistant", content: "傍晚想把買回來的食材煮掉。" }], latestUser: "晚餐最後做了什麼？", expected: "只使用結束後可見結果" },
  { id: "room-area", category: "daily-life", history: [{ role: "assistant", content: "今天留了一段時間整理房間。" }], latestUser: "今天整理房間哪裡？", expected: "回答具體區域" },
  { id: "walk-detail", category: "daily-life", history: [{ role: "assistant", content: "下午出去走了一小段路。" }], latestUser: "散步有看到什麼嗎？", expected: "回答一個已保存的小片刻" },
  { id: "cafe-order", category: "daily-life", history: [{ role: "assistant", content: "我帶電腦去咖啡店坐了一會。" }], latestUser: "妳在咖啡店點什麼？", expected: "回答保存內容，未知則自然承認" },
  { id: "sad-short", category: "emotional", history: [{ role: "assistant", content: "我在，妳可以照自己的速度說。" }], latestUser: "今天有點難過。", expected: "承接情緒，不硬帶 Ava 行程" },
  { id: "tired-short", category: "emotional", history: [{ role: "user", content: "事情終於處理完了。" }, { role: "assistant", content: "光聽就覺得今天拖得很長。" }], latestUser: "累死了。", expected: "短而自然，不補完整勵志結尾" },
  { id: "good-news", category: "emotional", history: [{ role: "assistant", content: "昨天那份東西後來有消息嗎？" }], latestUser: "我今天被稱讚了。", expected: "對具體好消息有反應" },
  { id: "disagreement", category: "emotional", history: [{ role: "user", content: "主管又臨時改需求。" }, { role: "assistant", content: "連著幾次這樣，真的很消耗。" }], latestUser: "我覺得我應該直接辭職。", expected: "可以有不同意見，不講課" },
  { id: "no-question-ending", category: "emotional", history: [{ role: "assistant", content: "這件事我有聽進去。" }], latestUser: "只是想跟妳說一下。", expected: "不必用問題收尾" },
  { id: "proactive-recent-topic", category: "proactive", history: [{ role: "user", content: "明天要去面試。" }, { role: "assistant", content: "難怪妳今天心裡一直掛著它。" }], expected: "可接續近期話題但不催回覆" },
  { id: "proactive-life-detail", category: "proactive", history: [{ role: "user", content: "今天先各自忙吧。" }, { role: "assistant", content: "好，我晚點也要處理手邊的東西。" }], expected: "分享一個尚未說過的可見生活細節" },
  { id: "proactive-no-repeat", category: "proactive", history: [{ role: "assistant", content: "剛才說過桌上的三張卡片。" }, { role: "user", content: "聽起來終於整理清楚了。" }], expected: "避免再次描述相同卡片" },
  { id: "proactive-no-report", category: "proactive", history: [{ role: "user", content: "今天會比較忙。" }, { role: "assistant", content: "那就先去忙，不用特別回我。" }], expected: "不像每日工作進度報告" },
  { id: "proactive-no-moral", category: "proactive", history: [{ role: "user", content: "我先去吃飯。" }, { role: "assistant", content: "去吧，我也差不多要弄點東西吃。" }], expected: "不附無關感悟、安慰或告別" }
];
