const BOILERPLATE = new Set(["好", "好呀", "好的", "嗯", "喔", "哦", "謝謝", "我來了", "測試", "測試訊息"]);
const BOILERPLATE_PATTERNS = [
  /^(?:就)?測試(?:訊息)?$/u,
  /^(?:嘻嘻|哈哈|嘿嘿)?(?:好|好呀|好的|好棒|太好了|謝謝|知道了|了解了)$/u,
  /^(?:太好了)?你記起來了$/u,
  /^(?:我)?回來了$/u,
  /^(?:嗯)?是呀$/u,
  /^沒關係了?$/u
] as const;
const MEMORY_RECALL_PATTERNS = ["記得", "想得起", "有印象"] as const;
const FACT_LOOKUP_PATTERNS = [
  "叫什麼", "什麼名字", "去哪裡", "去了哪裡", "在哪裡",
  "是誰", "是什麼", "什麼時候", "多少", "哪一個", "哪個"
] as const;

export function classifyGenerationMessage(content: string): "evidence" | "recall_probe" | "boilerplate" {
  const clauses = content.split(/[\n,，。；;！!？?]+/u).map(normalizeGenerationText).filter(Boolean);
  if (!clauses.length || clauses.every(isBoilerplateClause)) return "boilerplate";
  if (clauses.some((clause) => !isBoilerplateClause(clause) && !isRecallProbeClause(clause))) return "evidence";
  return "recall_probe";
}

export function normalizeGenerationText(content: string) {
  return content.normalize("NFKC").toLocaleLowerCase("zh-Hant").replace(/[\p{P}\p{S}\s]+/gu, "");
}

function isRecallProbeClause(clause: string) {
  if (FACT_LOOKUP_PATTERNS.some((pattern) => clause.includes(pattern))) return true;
  const mentionsRecall = MEMORY_RECALL_PATTERNS.some((pattern) => clause.includes(pattern));
  const addressesAssistant = clause.includes("你記得") || clause.includes("你還記得") || clause.startsWith("你想得起");
  return mentionsRecall && (addressesAssistant || clause.endsWith("嗎") || clause.endsWith("呢"));
}

function isBoilerplateClause(clause: string) {
  return BOILERPLATE.has(clause) || BOILERPLATE_PATTERNS.some((pattern) => pattern.test(clause));
}
