/**
 * Resolves Polymarket **event** title and outcome label (Yes/No, Up/Down, …) for a CLOB `tokenId`
 * via Gamma HTTP API.
 */

export type PolymarketMarketLabels = {
  event: string;
  outcome: string;
};

export async function fetchPolymarketMarketLabels(tokenId: string): Promise<PolymarketMarketLabels> {
  try {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.set("clob_token_ids", tokenId);
    url.searchParams.set("limit", "1");
    const res = await fetch(url);
    if (!res.ok) {
      return unknownLabels();
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || data.length === 0) {
      return unknownLabels();
    }
    const m = data[0] as Record<string, unknown>;
    const evs = Array.isArray(m.events) ? (m.events as { title?: string | null }[]) : undefined;
    const fromEvent = evs?.[0]?.title?.trim();
    const question = typeof m.question === "string" ? m.question.trim() : "";
    const event = oneLine(fromEvent || question || "(unknown)");
    const outcome = outcomeLabelForToken(m, tokenId);
    return { event, outcome };
  } catch {
    return unknownLabels();
  }
}

function unknownLabels(): PolymarketMarketLabels {
  return { event: "(unknown)", outcome: "(unknown)" };
}

function outcomeLabelForToken(m: Record<string, unknown>, tokenId: string): string {
  const ids = parseJsonStringArray(m["clobTokenIds"] ?? m["clob_token_ids"]);
  const outcomes = parseJsonStringArray(m["outcomes"]);
  if (!ids || !outcomes || ids.length !== outcomes.length) {
    return "(unknown)";
  }
  const idx = ids.findIndex((id) => normalizeTokenId(id) === normalizeTokenId(tokenId));
  if (idx < 0 || idx >= outcomes.length) {
    return "(unknown)";
  }
  return oneLine(outcomes[idx]!);
}

function normalizeTokenId(id: string): string {
  return id.trim().toLowerCase().replace(/^0x/, "");
}

function parseJsonStringArray(raw: unknown): string[] | null {
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p) && p.every((x) => typeof x === "string")) {
        return p as string[];
      }
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return raw as string[];
  }
  return null;
}

/**
 * Resolves a human-readable Polymarket **event** title for a CLOB outcome `tokenId`
 * via Gamma HTTP API (event title, else market question).
 */
export async function fetchPolymarketEventLabel(tokenId: string): Promise<string> {
  const { event } = await fetchPolymarketMarketLabels(tokenId);
  return event;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 240);
}
