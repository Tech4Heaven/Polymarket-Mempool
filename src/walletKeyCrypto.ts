import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

export type EncWalletV1 = {
  v: 1;
  alg: "scrypt-aes-256-gcm-v1";
  salt: string;
  iv: string;
  ct: string;
  tag: string;
};

const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 32;
const PT_LEN = 32;

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 256 * 1024 * 1024 });
}

export function isEncryptedWalletV1(v: unknown): v is EncWalletV1 {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || o.alg !== "scrypt-aes-256-gcm-v1") {
    return false;
  }
  for (const k of ["salt", "iv", "ct", "tag"] as const) {
    if (typeof o[k] !== "string" || !o[k]) {
      return false;
    }
  }
  return true;
}

export function encryptPrivateKeyToEnvelope(plainHex: string, passphrase: string): EncWalletV1 {
  const pk = parsePlainHexToBuffer(plainHex);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(pk), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "scrypt-aes-256-gcm-v1",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function parsePlainHexToBuffer(plainHex: string): Buffer {
  let s = plainHex.trim().replace(/\s+/g, "");
  if (s.startsWith("0x") || s.startsWith("0X")) {
    s = s.slice(2);
  }
  const lower = s.toLowerCase();
  if (lower.length !== 64 || !/^[0-9a-f]{64}$/.test(lower)) {
    throw new Error("Private key must be 64 hex characters (32 bytes), optional 0x prefix");
  }
  return Buffer.from(lower, "hex");
}

export function decryptPrivateKeyEnvelope(payload: EncWalletV1, passphrase: string): string {
  let salt: Buffer;
  let iv: Buffer;
  let ct: Buffer;
  let tag: Buffer;
  try {
    salt = Buffer.from(payload.salt, "base64");
    iv = Buffer.from(payload.iv, "base64");
    ct = Buffer.from(payload.ct, "base64");
    tag = Buffer.from(payload.tag, "base64");
  } catch {
    throw new Error("Invalid wallet envelope (bad base64)");
  }
  if (salt.length < 16 || iv.length !== IV_LEN || tag.length !== 16) {
    throw new Error("Invalid wallet envelope (wrong lengths)");
  }
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("Wallet unlock failed (wrong passphrase or corrupted file)");
  }
  if (pt.length !== PT_LEN) {
    throw new Error("Wallet unlock failed (unexpected plaintext length)");
  }
  const hex = pt.toString("hex");
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("Wallet unlock failed (invalid key material)");
  }
  return `0x${hex}`;
}
