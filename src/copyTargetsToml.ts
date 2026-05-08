import { readFile } from "fs/promises";
import { resolve } from "path";
import { parse } from "@iarna/toml";
import { getAddress, isAddress } from "ethers";

export type TomlClobSection = {
  enabled?: boolean;
  dry_run?: boolean;
  private_key?: string;
  signature_type?: number;
  funder_address?: string;
  polygon_http_url?: string;
  clob_host?: string;
  /** Defaults applied to each [[targets]] row when a field is omitted */
  copy_ratio?: number;
  max_price_difference?: number;
  min_position_usdc?: number;
  max_position_usdc?: number;
};

export type TomlTargetRow = {
  address: string;
  username?: string;
  copy_ratio?: number;
  max_price_difference?: number;
  min_position_usdc?: number;
  max_position_usdc?: number;
};

export type ParsedCopyTargetsToml = {
  clob: TomlClobSection | undefined;
  targets: TomlTargetRow[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numOrUndef(k: string, o: Record<string, unknown>): number | undefined {
  if (!(k in o)) {
    return undefined;
  }
  const v = o[k];
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  return undefined;
}

function strOrUndef(k: string, o: Record<string, unknown>): string | undefined {
  if (!(k in o)) {
    return undefined;
  }
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function boolOrUndef(k: string, o: Record<string, unknown>): boolean | undefined {
  if (!(k in o)) {
    return undefined;
  }
  return typeof o[k] === "boolean" ? o[k] : undefined;
}

export async function parseCopyTargetsTomlFile(filePath: string): Promise<ParsedCopyTargetsToml> {
  const abs = resolve(filePath);
  const raw = await readFile(abs, "utf8");
  const doc = parse(raw) as unknown;
  const root = asRecord(doc);
  if (!root) {
    throw new Error(`copy targets TOML: expected table at root (${abs})`);
  }

  let clob: TomlClobSection | undefined;
  const clobRaw = root["clob"];
  const clobTab = asRecord(clobRaw);
  if (clobTab) {
    clob = {
      enabled: boolOrUndef("enabled", clobTab),
      dry_run: boolOrUndef("dry_run", clobTab),
      private_key: strOrUndef("private_key", clobTab),
      signature_type: numOrUndef("signature_type", clobTab),
      funder_address: strOrUndef("funder_address", clobTab),
      polygon_http_url: strOrUndef("polygon_http_url", clobTab),
      clob_host: strOrUndef("clob_host", clobTab),
      copy_ratio: numOrUndef("copy_ratio", clobTab),
      max_price_difference: numOrUndef("max_price_difference", clobTab),
      min_position_usdc: numOrUndef("min_position_usdc", clobTab),
      max_position_usdc: numOrUndef("max_position_usdc", clobTab),
    };
  }

  const targetsRaw = root["targets"];
  if (!Array.isArray(targetsRaw)) {
    throw new Error(`copy targets TOML: missing [[targets]] array (${abs})`);
  }

  const targets: TomlTargetRow[] = [];
  for (let i = 0; i < targetsRaw.length; i++) {
    const row = asRecord(targetsRaw[i]);
    if (!row) {
      throw new Error(`copy targets TOML: targets[${i}] must be a table (${abs})`);
    }
    const addrRaw = strOrUndef("address", row);
    if (!addrRaw || !isAddress(addrRaw)) {
      throw new Error(`copy targets TOML: targets[${i}].address invalid (${abs})`);
    }
    targets.push({
      address: getAddress(addrRaw),
      username: strOrUndef("username", row),
      copy_ratio: numOrUndef("copy_ratio", row),
      max_price_difference: numOrUndef("max_price_difference", row),
      min_position_usdc: numOrUndef("min_position_usdc", row),
      max_position_usdc: numOrUndef("max_position_usdc", row),
    });
  }

  if (targets.length === 0) {
    throw new Error(`copy targets TOML: need at least one [[targets]] (${abs})`);
  }

  return { clob, targets };
}
