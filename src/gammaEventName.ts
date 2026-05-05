/**
 * Resolves a human-readable Polymarket **event** label for a CLOB outcome `tokenId`
 * via Gamma HTTP API (no CLOB round-trip on the hot path until we explicitly call this).
 */
export async function fetchPolymarketEventLabel(tokenId: string): Promise<string> {
  try {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.set("clob_token_ids", tokenId);
    url.searchParams.set("limit", "1");
    const res = await fetch(url);
    if (!res.ok) {
      return "(unknown)";
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || data.length === 0) {
      return "(unknown)";
    }
    const m = data[0] as {
      question?: string | null;
      events?: { title?: string | null }[];
    };
    const eventTitle = m.events?.[0]?.title?.trim();
    if (eventTitle) {
      return oneLine(eventTitle);
    }
    const q = m.question?.trim();
    if (q) {
      return oneLine(q);
    }
    return "(unknown)";
  } catch {
    return "(unknown)";
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 240);
}
