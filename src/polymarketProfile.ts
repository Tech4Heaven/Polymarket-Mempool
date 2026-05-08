/**
 * Resolves a display label for log filenames via Gamma `public-profile` (wallet → name / pseudonym).
 * @see https://docs.polymarket.com/api-reference/profiles/get-public-profile-by-wallet-address
 */
export async function fetchPolymarketProfileLabel(walletAddress: string): Promise<string | null> {
  const addr = walletAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return null;
  }
  try {
    const url = new URL("https://gamma-api.polymarket.com/public-profile");
    url.searchParams.set("address", addr);
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const name = typeof data["name"] === "string" ? data["name"].trim() : "";
    if (name) {
      return name;
    }
    const pseudonym = typeof data["pseudonym"] === "string" ? data["pseudonym"].trim() : "";
    return pseudonym || null;
  } catch {
    return null;
  }
}
