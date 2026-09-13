import { visibleAvaEventFacts, type AvaEventFacts } from "./avaEventFacts.js";

export type AvaEventCategory = "work" | "life";

export type AvaEventPhase = {
  key: string;
  activity: string;
  moodNote: string;
  activityStartMinute: number;
  activityEndMinute: number;
  beforeBackground: string;
  duringBackground: string;
  afterBackground: string;
  scene: string;
  visibleDetails: readonly string[];
  progress: string;
  completion: "begin" | "continue" | "complete" | "transition";
  anonymousInteraction?: string;
};

export type AvaEventActivityStage = "before" | "during" | "after";

export type AvaEventMoment = {
  title: string;
  day: number;
  stage: AvaEventActivityStage;
  stageLabel: "準備" | "進行中" | "結束後";
  activity: string;
  moodNote: string;
  background: string;
  knownFacts: readonly string[];
};

export type AvaEventDefinition = {
  key: string;
  title: string;
  category: AvaEventCategory;
  durationDays: 2 | 3;
  anchorTerms: readonly string[];
  phases: readonly AvaEventPhase[];
};

const eventDefinitions: readonly AvaEventDefinition[] = [
  {
    key: "brand-proposal-revision",
    title: "品牌提案修改",
    category: "work",
    durationDays: 3,
    anchorTerms: ["提案", "簡報", "品牌"],
    phases: [
      {
        key: "outline",
        activity: "把品牌提案的主軸攤開來整理",
        moodNote: "剛進入狀態，方向還有些散",
        activityStartMinute: 10 * 60,
        activityEndMinute: 17 * 60,
        beforeBackground: "還沒開始整理提案，先照平常節奏吃早餐、準備今天要用的東西",
        duringBackground: "正在整理品牌提案的主軸，注意力放在桌上的資料",
        afterBackground: "今天先把提案方向攤開看過，已經停下來休息",
        scene: "桌上攤著便條紙和電腦，先把零散想法排成幾個方向",
        visibleDetails: ["便條紙", "螢幕上的簡報", "被劃掉又重寫的標題"],
        progress: "先讓方向看得見，還沒有急著定稿",
        completion: "begin"
      },
      {
        key: "revision",
        activity: "把提案裡卡住的段落重新調整",
        moodNote: "有點費神，但比昨天知道該從哪裡下手",
        activityStartMinute: 10 * 60,
        activityEndMinute: 17 * 60,
        beforeBackground: "今天的提案修改還沒開始，早上先讓腦袋慢慢醒來",
        duringBackground: "正在重新調整提案裡卡住的段落，手邊放著兩個版本",
        afterBackground: "今天的修改已經告一段落，剩下的留到下一次再看",
        scene: "把幾頁內容來回對照，慢慢替換不太對勁的順序",
        visibleDetails: ["兩個並排的版本", "游標停在段落中間", "冷掉的水杯"],
        progress: "中間的骨架已經接起來，剩下幾個地方需要取捨",
        completion: "continue"
      },
      {
        key: "delivery",
        activity: "檢查提案後把檔案整理好送出",
        moodNote: "鬆下來一點，也有完成後的空白感",
        activityStartMinute: 13 * 60,
        activityEndMinute: 16 * 60,
        beforeBackground: "最後檢查還沒開始，早上先做自己的事，不把提案說成已經送出",
        duringBackground: "正在檢查提案的檔名與頁面順序，準備把這次工作完成",
        afterBackground: "提案已經整理好並送出，這件事今天確實結束了",
        scene: "最後看過檔名和頁面順序，把桌上的紙收成一疊",
        visibleDetails: ["整理好的檔案名稱", "闔上的電腦", "收起來的便條紙"],
        progress: "這件事已經交出去，今天不再繼續修改",
        completion: "complete"
      }
    ]
  },
  {
    key: "photo-final-pass",
    title: "照片挑選",
    category: "work",
    durationDays: 2,
    anchorTerms: ["照片", "畫面", "縮圖"],
    phases: [
      {
        key: "review",
        activity: "挑選照片並排出畫面的順序",
        moodNote: "眼睛有點累，還是想把畫面看準",
        activityStartMinute: 10 * 60,
        activityEndMinute: 16 * 60,
        beforeBackground: "還沒開始挑照片，先過自己的早晨，不預先描述挑選結果",
        duringBackground: "正在挑選照片並試著排列畫面順序",
        afterBackground: "今天的照片挑選先停在一個可接續的位置，眼睛也休息了",
        scene: "在螢幕前放大縮小幾張照片，比對它們排在一起時的呼吸",
        visibleDetails: ["縮圖列", "放大的照片", "調暗的螢幕亮度"],
        progress: "先找出能留下的畫面，順序還在試",
        completion: "begin"
      },
      {
        key: "polish",
        activity: "確認照片與文字的最後搭配",
        moodNote: "接近完成，心裡比較安定",
        activityStartMinute: 13 * 60,
        activityEndMinute: 16 * 60,
        beforeBackground: "最後搭配還沒開始，上午先做中性的日常安排",
        duringBackground: "正在確認照片和文字的最後搭配，逐一看過留白與順序",
        afterBackground: "照片與文字已經確認並收好，這組素材不再繼續調整",
        scene: "把選好的畫面一張張放回原位，確認最後一處留白",
        visibleDetails: ["排好的縮圖", "留白的版面", "合上的相片資料夾"],
        progress: "畫面和文字已經定下來，今天把這組素材收好",
        completion: "complete"
      }
    ]
  },
  {
    key: "copywriting-sprint",
    title: "文案改寫",
    category: "work",
    durationDays: 2,
    anchorTerms: ["文案", "句子", "段落"],
    phases: [
      {
        key: "rewrite",
        activity: "改寫一段內容文案",
        moodNote: "在不同句子之間找更剛好的語氣",
        activityStartMinute: 10 * 60,
        activityEndMinute: 16 * 60,
        beforeBackground: "文案改寫還沒開始，早上先讓思緒慢慢醒來",
        duringBackground: "正在改寫一段內容文案，在幾種句子之間來回比較",
        afterBackground: "今天的改寫已經停筆，留下可以隔天再看的版本",
        scene: "游標在同一行停了很久，刪掉幾個太用力的字再重新寫",
        visibleDetails: ["閃著的游標", "被刪掉的形容詞", "筆記本邊緣的箭頭"],
        progress: "語氣開始靠近想要的方向，還在慢慢試",
        completion: "begin"
      },
      {
        key: "refine",
        activity: "把文案讀過一遍後定下最後版本",
        moodNote: "不再那麼急，想讓它停在剛好的地方",
        activityStartMinute: 13 * 60,
        activityEndMinute: 16 * 60,
        beforeBackground: "最後校讀還沒開始，上午不把文案說成已經定稿",
        duringBackground: "正在從頭校讀文案，調整最後幾句的節奏",
        afterBackground: "文案最後版本已經定下來，今天不再回頭修改",
        scene: "從頭默讀一遍，把最後兩個句子的節奏換得更乾淨",
        visibleDetails: ["被標記的兩句話", "闔上的筆記本", "桌邊剩下的一口茶"],
        progress: "今天這段文字已經定下來，先把它留在這裡",
        completion: "complete"
      }
    ]
  },
  {
    key: "cafe-final-pass",
    title: "咖啡店工作",
    category: "work",
    durationDays: 2,
    anchorTerms: ["咖啡店", "電腦", "檔案"],
    phases: [
      {
        key: "focus",
        activity: "帶著電腦到咖啡店處理一份內容",
        moodNote: "外面有些聲音，反而比較能專心",
        activityStartMinute: 10 * 60,
        activityEndMinute: 17 * 60,
        beforeBackground: "還沒出發去咖啡店，先在家吃東西、準備電腦",
        duringBackground: "正在咖啡店用電腦處理內容，注意力留在手邊清單",
        afterBackground: "已經離開咖啡店，今天處理到的內容先留在電腦裡",
        scene: "靠窗坐下後把電腦打開，先把今天要做的幾件事列在紙上",
        visibleDetails: ["窗邊座位", "冒著熱氣的杯子", "寫了三行的清單"],
        progress: "先把注意力放回手邊，不急著一次做完",
        completion: "begin",
        anonymousInteraction: "店員把飲料放到桌邊"
      },
      {
        key: "wrap-up",
        activity: "把咖啡店裡完成的內容整理收好",
        moodNote: "專注過後有點累，但腦袋變得清爽",
        activityStartMinute: 14 * 60,
        activityEndMinute: 17 * 60,
        beforeBackground: "今天還沒到咖啡店收尾，先過上午的日常時間",
        duringBackground: "正在咖啡店整理完成的內容，準備存檔收起電腦",
        afterBackground: "檔案已經存好、電腦也收起來，這次咖啡店工作告一段落",
        scene: "存好檔案、把充電線繞起來，窗外的光線已經換了一層",
        visibleDetails: ["儲存完成的檔案", "收起來的充電線", "桌上空掉的杯子"],
        progress: "這次外出的工作已經告一段落，準備離開座位",
        completion: "transition"
      }
    ]
  },
  {
    key: "content-research-day",
    title: "內容資料蒐集",
    category: "work",
    durationDays: 2,
    anchorTerms: ["資料", "分頁", "筆記"],
    phases: [
      {
        key: "collect",
        activity: "蒐集一個內容企劃需要的參考資料",
        moodNote: "好奇心被拉起來，還不急著判斷",
        activityStartMinute: 10 * 60,
        activityEndMinute: 16 * 60,
        beforeBackground: "資料蒐集還沒開始，早上先做一般的準備",
        duringBackground: "正在幾個分頁之間蒐集內容企劃的參考資料",
        afterBackground: "今天的參考資料已經收進資料夾，暫時不再增加分頁",
        scene: "在幾個分頁之間切換，把有感覺的畫面和句子先放進資料夾",
        visibleDetails: ["開著的分頁", "資料夾縮圖", "寫到一半的關鍵字"],
        progress: "先把可用的材料收進來，讓方向慢慢浮現",
        completion: "begin"
      },
      {
        key: "map",
        activity: "把蒐集到的資料整理成可用的企劃筆記",
        moodNote: "材料太多，但開始看見彼此的關係",
        activityStartMinute: 10 * 60,
        activityEndMinute: 16 * 60,
        beforeBackground: "企劃筆記還沒開始整理，先讓早晨維持簡單",
        duringBackground: "正在把蒐集到的資料整理成企劃筆記，替重點分類連線",
        afterBackground: "企劃筆記已經整理到可用的程度，這輪資料蒐集正式停下來",
        scene: "把散在頁面的截圖拖到同一份筆記裡，替幾個重點畫上線",
        visibleDetails: ["截圖卡片", "連起來的箭頭", "被圈起來的關鍵字"],
        progress: "資料已經有了自己的位置，這輪蒐集可以先停下來",
        completion: "complete"
      }
    ]
  },
  {
    key: "home-refresh",
    title: "房間整理",
    category: "life",
    durationDays: 2,
    anchorTerms: ["房間", "桌面", "床單"],
    phases: [
      {
        key: "clear",
        activity: "把房間裡堆著的小東西慢慢歸位",
        moodNote: "不想做得很厲害，只想讓眼前舒服一點",
        activityStartMinute: 10 * 60,
        activityEndMinute: 12 * 60,
        beforeBackground: "房間整理還沒開始，起床後先吃早餐、慢慢醒來",
        duringBackground: "正在把房間裡堆著的小東西分開歸位",
        afterBackground: "今天先整理完一小區域，其他地方留到下一次",
        scene: "先從桌面開始，把散著的紙和充電線分成幾小堆",
        visibleDetails: ["桌上的紙張", "捲起的充電線", "空出來的一角"],
        progress: "只整理一小區域，讓空間先能呼吸",
        completion: "begin"
      },
      {
        key: "refresh",
        activity: "換好床單並把房間留成舒服的樣子",
        moodNote: "身體有點累，但回到房間時比較放鬆",
        activityStartMinute: 10 * 60,
        activityEndMinute: 12 * 60,
        beforeBackground: "還沒開始換床單，早上先照自己的節奏醒來",
        duringBackground: "正在換床單、收好洗衣籃，讓房間重新透氣",
        afterBackground: "床單和房間都整理好了，今天不再替自己增加家務",
        scene: "把窗簾拉開透氣，換下來的東西收進洗衣籃",
        visibleDetails: ["剛換好的床單", "透進來的光", "收好的洗衣籃"],
        progress: "房間已經整理到想停下來休息的程度，今天不再加項目",
        completion: "complete"
      }
    ]
  },
  {
    key: "grocery-and-cooking",
    title: "補貨做飯",
    category: "life",
    durationDays: 2,
    anchorTerms: ["食材", "蔬菜", "廚房"],
    phases: [
      {
        key: "restock",
        activity: "出門補一些日常會用到的食材",
        moodNote: "步調很普通，卻有種把生活接回來的感覺",
        activityStartMinute: 10 * 60,
        activityEndMinute: 12 * 60,
        beforeBackground: "還沒出門補貨，先吃早餐、看看家裡缺什麼",
        duringBackground: "正在店裡補日常食材，購物籃裡放著幾樣蔬菜",
        afterBackground: "食材已經帶回家收好，今天的補貨到這裡結束",
        scene: "提著購物籃在架前挑幾樣蔬菜和常吃的東西",
        visibleDetails: ["購物籃", "挑好的蔬菜", "結帳後的小收據"],
        progress: "先把冰箱裡缺的東西補上，晚點再慢慢處理",
        completion: "begin",
        anonymousInteraction: "櫃台結帳時把東西一樣樣放進袋子"
      },
      {
        key: "cook",
        activity: "用買回來的食材做一頓簡單的飯",
        moodNote: "聞到熱氣後，整個人慢慢放下來",
        activityStartMinute: 17 * 60 + 30,
        activityEndMinute: 19 * 60 + 30,
        beforeBackground: "晚餐還沒開始做，白天先過自己的日常，不提前描述料理結果",
        duringBackground: "正在廚房處理食材、做一頓簡單的飯",
        afterBackground: "飯已經吃完、廚房也收好了，這次補貨做飯完整結束",
        scene: "洗好菜後讓鍋子慢慢熱起來，把切好的食材排在砧板旁",
        visibleDetails: ["砧板上的食材", "冒著熱氣的鍋", "洗好的碗"],
        progress: "這一餐吃完就收好廚房，讓晚上回到平穩的節奏",
        completion: "complete"
      }
    ]
  },
  {
    key: "bookstore-walk",
    title: "書店散步",
    category: "life",
    durationDays: 2,
    anchorTerms: ["書店", "書", "書架"],
    phases: [
      {
        key: "browse",
        activity: "到書店隨意看看新書和雜誌",
        moodNote: "沒有要找答案，只想讓腦袋換一個頻道",
        activityStartMinute: 13 * 60 + 30,
        activityEndMinute: 17 * 60,
        beforeBackground: "還沒出發去書店，上午先過安靜的日常時間",
        duringBackground: "正在書店的書架間隨意翻看新書和雜誌",
        afterBackground: "已經離開書店，帶著剛才翻過幾頁的餘韻回去",
        scene: "在書架前慢慢抽出幾本書，翻到有意思的頁面就停一下",
        visibleDetails: ["書脊", "翻開的跨頁", "夾在手指間的書籤"],
        progress: "先讓自己逛一會兒，不需要帶著目標離開",
        completion: "begin"
      },
      {
        key: "pause",
        activity: "帶著一本挑中的書找地方坐一下",
        moodNote: "心裡變安靜，不急著再塞更多事情",
        activityStartMinute: 14 * 60,
        activityEndMinute: 17 * 60,
        beforeBackground: "今天的書店散步還沒開始，上午不預先說已經挑到書",
        duringBackground: "正在書店翻看挑中的書，找地方坐下讀幾頁",
        afterBackground: "這趟書店散步已經結束，挑中的書也帶回來了",
        scene: "把挑中的書放在腿上，讀了幾頁後抬頭看看外面的天色",
        visibleDetails: ["挑中的書", "停在半頁的手指", "慢下來的光線"],
        progress: "這趟散步已經夠了，帶著一點餘韻回去",
        completion: "transition"
      }
    ]
  },
  {
    key: "reset-weekend",
    title: "週末整理散步",
    category: "life",
    durationDays: 2,
    anchorTerms: ["桌面", "房間", "散步"],
    phases: [
      {
        key: "tidy",
        activity: "整理房間和桌上的小東西",
        moodNote: "步調很慢，只想先把眼前弄舒服",
        activityStartMinute: 10 * 60,
        activityEndMinute: 12 * 60,
        beforeBackground: "還沒開始整理，起床後先慢慢吃早餐",
        duringBackground: "正在整理房間和桌上的小東西，先空出一小塊桌面",
        afterBackground: "桌面已經整理出一個舒服的位置，今天的整理先停下來",
        scene: "把桌上的雜物挪開，留下一個可以放杯子的空位",
        visibleDetails: ["空出的桌面", "收進盒子的小物", "擦過的杯墊"],
        progress: "只做能在今天完成的小事，不把休息日變成任務",
        completion: "begin"
      },
      {
        key: "walk",
        activity: "出門走一段路，讓自己慢慢休息",
        moodNote: "沒有特別安排，想讓一天自然發生",
        activityStartMinute: 14 * 60,
        activityEndMinute: 17 * 60,
        beforeBackground: "散步還沒開始，上午和中午先留在自己的日常裡",
        duringBackground: "正在附近散步，腳步放慢看看沿路的樹影",
        afterBackground: "已經散步回來，週末的整理和外出都停在剛好的地方",
        scene: "沿著熟悉的街口走了一段，在路邊停下來看看樹影",
        visibleDetails: ["人行道的影子", "路邊的樹", "慢下來的腳步"],
        progress: "今天的整理到這裡就好，剩下的時間留給自己",
        completion: "complete"
      }
    ]
  },
  {
    key: "slow-sunday",
    title: "慢週日家務",
    category: "life",
    durationDays: 2,
    anchorTerms: ["衣服", "洗衣機", "家務"],
    phases: [
      {
        key: "laundry",
        activity: "處理堆著的衣服和一些家務",
        moodNote: "有點懶散，但做起來後意外地踏實",
        activityStartMinute: 9 * 60 + 30,
        activityEndMinute: 12 * 60,
        beforeBackground: "家務還沒開始，先讓剛醒來的步調慢一點",
        duringBackground: "正在把衣服分類放進洗衣機，順手處理一點家務",
        afterBackground: "衣服已經洗好，上午的家務暫時告一段落",
        scene: "把衣服分好放進洗衣機，等著的時候擦了擦洗手台",
        visibleDetails: ["分好的衣服", "洗衣機的聲音", "擦乾的洗手台"],
        progress: "讓家務慢慢跑著，不把自己催得太緊",
        completion: "begin"
      },
      {
        key: "afternoon",
        activity: "在洗好的衣服旁安排一個慢下午",
        moodNote: "事情不多，終於有一點不必趕路的空白",
        activityStartMinute: 14 * 60,
        activityEndMinute: 17 * 60,
        beforeBackground: "慢下午還沒開始，上午先吃東西、做些中性的日常小事",
        duringBackground: "正在把洗好的衣服摺好，替自己留一段不排事情的下午",
        afterBackground: "衣服已經收好，接下來沒有新的待辦，這個週日慢慢結束",
        scene: "把衣服一件件摺好，替自己倒了一杯冰的東西坐下來",
        visibleDetails: ["摺好的衣服", "桌上的冰杯", "沒被填滿的下午"],
        progress: "家務收好了，接下來不安排新的待辦",
        completion: "complete"
      }
    ]
  }
];

export function listAvaEventDefinitions() {
  return eventDefinitions;
}

export function getAvaEventDefinition(key: string) {
  const event = eventDefinitions.find((candidate) => candidate.key === key);
  if (!event) throw new Error(`unknown_ava_event:${key}`);
  return event;
}

export function getAvaEventPhase(key: string, eventDay: number) {
  const event = getAvaEventDefinition(key);
  const phase = event.phases[eventDay - 1];
  if (!phase) throw new Error(`unknown_ava_event_phase:${key}:${eventDay}`);
  return phase;
}

export function resolveAvaEventMoment(input: {
  eventKey: string;
  eventDay: number;
  minuteOfDay: number;
  eventDetail?: string | null;
  eventFacts?: AvaEventFacts | null;
}): AvaEventMoment {
  const event = getAvaEventDefinition(input.eventKey);
  const phase = getAvaEventPhase(input.eventKey, input.eventDay);
  const stage: AvaEventActivityStage = input.minuteOfDay < phase.activityStartMinute
    ? "before"
    : input.minuteOfDay < phase.activityEndMinute
      ? "during"
      : "after";
  const baseBackground = stage === "before"
    ? phase.beforeBackground
    : stage === "during"
      ? `${phase.duringBackground}。可用的具體場景：${phase.scene}`
      : [phase.afterBackground, input.eventDetail].filter(Boolean).join(" ");
  const knownFacts = visibleAvaEventFacts({ facts: input.eventFacts, eventDay: input.eventDay, stage });
  const background = knownFacts.length
    ? `${baseBackground} 可沿用的確定事實：${knownFacts.join("；")}`
    : baseBackground;
  return {
    title: event.title,
    day: input.eventDay,
    stage,
    stageLabel: stage === "before" ? "準備" : stage === "during" ? "進行中" : "結束後",
    activity: phase.activity,
    moodNote: phase.moodNote,
    background,
    knownFacts
  };
}

export function buildAvaEventDetailInstructions() {
  return `你正在為 AI 虛擬朋友 Ava 寫一段私有、虛構的當日生活背景。這不是要直接傳給使用者的訊息。
只用繁體中文寫 1～2 句，40～140 個字。每次都必須寫出至少一個可觀察的小片刻：場景、物件、動作或有限的匿名短互動。依照提供的進度寫：第一天建立情境，中段有明確變化，最後一天要落定或轉場。
這段文字是當日活動可使用的素材，不是生成當下的即時狀態。避免「剛剛、現在、目前、已經、今天早上、今晚」等把內容綁死在生成時刻的說法。
只可使用提供的事件、場景線索與匿名互動。匿名互動限店員、櫃台、路人或店家，不可命名、不可成為固定人物，也不可延伸成關係。
不得新增朋友、家人、伴侶、同事、客戶、團隊、主管、見面、約會、訊息往來、使用者共同經歷、日期或未提供的重大事件；不要提到使用者、直接對任何人說話，或寫出對話台詞。
不要寫成行程報告、日記或解釋。避免抽象地重複「慢慢收束、安靜調整、貼近方向」；讓具體片刻自然成為之後對話可偶爾帶到的背景。`;
}

export function buildAvaEventDetailInput(input: {
  eventKey: string;
  eventDay: number;
  phaseKey: string;
  activity: string;
  moodNote: string;
  eventTitle: string;
  anchorTerms: readonly string[];
  scene: string;
  visibleDetails: readonly string[];
  progress: string;
  completion: AvaEventPhase["completion"];
  anonymousInteraction?: string;
  previousDetail?: string | null;
  eventFacts?: AvaEventFacts | null;
}) {
  const availableFacts = visibleAvaEventFacts({
    facts: input.eventFacts,
    eventDay: input.eventDay,
    stage: "after"
  });
  return [
    `事件：${input.eventKey}（${input.eventTitle}）`,
    `第 ${input.eventDay} 天，phase：${input.phaseKey}，全日事件進度：${input.completion}`,
    `今天的活動：${input.activity}`,
    `今天的情緒底色：${input.moodNote}`,
    `必須保留的事件錨點之一：${input.anchorTerms.join("、")}`,
    `可用場景：${input.scene}`,
    `可見線索：${input.visibleDetails.join("、")}`,
    `這一天結束前應有的進度變化：${input.progress}`,
    availableFacts.length ? `這條事件已確立且本日可使用的事實：${availableFacts.join("；")}` : "這條事件沒有額外生成的具體事實，沿用固定骨架。",
    input.anonymousInteraction ? `可使用一次匿名互動：${input.anonymousInteraction}` : "今天沒有匿名互動。",
    input.previousDetail ? `同一事件昨天的背景：${input.previousDetail}` : "這是這條事件的第一天，沒有昨天背景。"
  ].join("\n");
}

export function validateAvaEventDetail(value: string, anchorTerms?: readonly string[]) {
  const detail = value.replace(/\s+/g, " ").trim();
  if (detail.length < 20 || detail.length > 180) return null;
  const sentenceCount = detail.match(/[。！？!?]/g)?.length ?? 0;
  if (sentenceCount < 1 || sentenceCount > 2) return null;
  if (/[「」『』"“”]/.test(detail)) return null;
  if (/(朋友|家人|伴侶|同事|客戶|團隊|主管|老師|醫生|見面|碰面|約會|傳訊息|收到訊息|你|妳|使用者)/.test(detail)) return null;
  if (anchorTerms?.length && !anchorTerms.some((anchor) => detail.includes(anchor))) return null;
  return detail;
}

export function selectNextAvaEvent(input: {
  startDate: string;
  recentEventKeys?: readonly string[];
  previousEventKey?: string | null;
}) {
  const recentEventKeys = uniqueEventKeys(
    input.recentEventKeys?.length
      ? input.recentEventKeys
      : input.previousEventKey
        ? [input.previousEventKey]
        : []
  ).slice(0, 3);
  const blockedKeys = new Set(recentEventKeys);
  const candidates = eventDefinitions.filter((event) => !blockedKeys.has(event.key));
  const recentCategories = recentEventKeys
    .map((key) => eventDefinitions.find((event) => event.key === key)?.category)
    .filter((category): category is AvaEventCategory => Boolean(category));
  const sameRecentCategory = recentCategories.length === 3 && new Set(recentCategories).size === 1
    ? recentCategories[0]
    : null;
  const balancedCandidates = sameRecentCategory
    ? candidates.filter((event) => event.category !== sameRecentCategory)
    : candidates;
  const pool = balancedCandidates.length ? balancedCandidates : candidates;
  const seed = stableHash(`${input.startDate}:${recentEventKeys.join(",")}`);
  return pool[seed % pool.length]!;
}

function uniqueEventKeys(keys: readonly string[]) {
  return [...new Set(keys.filter(Boolean))];
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
