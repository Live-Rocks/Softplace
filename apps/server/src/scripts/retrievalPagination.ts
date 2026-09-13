export const RETRIEVAL_PAGE_SIZE = 200;

export type Keyset = { primary: string | number; id: string };

export async function collectKeysetPages<T>(input: {
  upper: Keyset | null;
  loadPage: (cursor: Keyset | null, upper: Keyset, limit: number) => Promise<T[]>;
  key: (row: T) => Keyset;
  pageSize?: number;
}) {
  if (!input.upper) return [];
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: Keyset | null = null;
  while (true) {
    const page = await input.loadPage(cursor, input.upper, input.pageSize ?? RETRIEVAL_PAGE_SIZE);
    if (!page.length) break;
    for (const row of page) {
      const key = input.key(row);
      const serialized = `${key.primary}:${key.id}`;
      if (seen.has(serialized)) throw new Error("retrieval_pagination_duplicate");
      if (cursor && compareKeyset(key, cursor) <= 0) throw new Error("retrieval_pagination_unordered");
      if (compareKeyset(key, input.upper) > 0) throw new Error("retrieval_pagination_upper_bound");
      seen.add(serialized);
      rows.push(row);
      cursor = key;
    }
  }
  return rows;
}

export function compareKeyset(left: Keyset, right: Keyset) {
  const primary = typeof left.primary === "number" && typeof right.primary === "number"
    ? left.primary - right.primary
    : String(left.primary).localeCompare(String(right.primary));
  return primary || left.id.localeCompare(right.id);
}

export function timestampAfter(cursor: Keyset) {
  return `created_at.gt.${cursor.primary},and(created_at.eq.${cursor.primary},id.gt.${cursor.id})`;
}

export function timestampAtOrBefore(upper: Keyset) {
  return `created_at.lt.${upper.primary},and(created_at.eq.${upper.primary},id.lte.${upper.id})`;
}

export function sequenceAfter(cursor: Keyset) {
  return `message_sequence.gt.${cursor.primary},and(message_sequence.eq.${cursor.primary},id.gt.${cursor.id})`;
}

export function sequenceAtOrBefore(upper: Keyset) {
  return `message_sequence.lt.${upper.primary},and(message_sequence.eq.${upper.primary},id.lte.${upper.id})`;
}

export function keysetWindow(field: "created_at" | "message_sequence", cursor: Keyset | null, upper: Keyset) {
  if (!cursor) return `${field}.lt.${upper.primary},and(${field}.eq.${upper.primary},id.lte.${upper.id})`;
  if (String(cursor.primary) === String(upper.primary)) {
    return `and(${field}.eq.${upper.primary},id.gt.${cursor.id},id.lte.${upper.id})`;
  }
  return [
    `and(${field}.eq.${cursor.primary},id.gt.${cursor.id})`,
    `and(${field}.gt.${cursor.primary},${field}.lt.${upper.primary})`,
    `and(${field}.eq.${upper.primary},id.lte.${upper.id})`
  ].join(",");
}
