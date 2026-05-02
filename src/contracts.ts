/**
 * Polymarket CLOB V2 / CTF Exchange V2 — Polygon mainnet (chainId 137).
 * Source of truth: https://docs.polymarket.com/resources/contracts
 * Upgrade context (April 28, 2026): https://docs.polymarket.com/v2-migration
 */

export const POLYGON_CHAIN_ID = 137;

/** Core CTF Exchange V2 (binary / standard markets). */
export const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";

/** Neg-risk CTF Exchange V2 (negative-risk markets). */
export const NEG_RISK_CTF_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";

export const EXCHANGE_V2_ADDRESSES = [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] as const;

/** Conditional Tokens Framework (ERC-1155 outcome tokens). */
export const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

/** Polymarket USD (pUSD) — CollateralToken proxy (ERC-20, 6 decimals). */
export const PUSD_TOKEN = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
