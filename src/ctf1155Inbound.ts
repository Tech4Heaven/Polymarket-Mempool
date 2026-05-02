import { formatUnits, Interface, type Log, type TransactionReceipt } from "ethers";
import { CONDITIONAL_TOKENS } from "./contracts.js";

const erc1155Iface = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);

/** Display scaling: raw units ÷ 1_000_000 (same as `formatUnits(x, 6)`). */
export function amountPer1e6(raw: bigint): string {
  return formatUnits(raw, 6);
}

export type Ctf1155TransferRow = {
  tokenId: string;
  rawAmount: bigint;
  /** `rawAmount / 1_000_000` as a decimal string. */
  amountPer1e6: string;
};

/** @deprecated Use {@link Ctf1155TransferRow} */
export type InboundCtf1155Row = Ctf1155TransferRow;

function row(id: bigint, value: bigint): Ctf1155TransferRow {
  return {
    tokenId: id.toString(),
    rawAmount: value,
    amountPer1e6: amountPer1e6(value),
  };
}

/**
 * Parses Conditional Tokens ERC-1155 logs for a mined tx:
 * - **inbound**: transfers **to** a target (typical on buys — outcome tokens received).
 * - **outbound**: transfers **from** a target (typical on sells — outcome tokens sent).
 */
export function extractCtf1155TransfersForTargets(
  receipt: TransactionReceipt,
  targets: string[]
): { inbound: Ctf1155TransferRow[]; outbound: Ctf1155TransferRow[] } {
  const want = new Set(targets.map((a) => a.toLowerCase()));
  const ctfLc = CONDITIONAL_TOKENS.toLowerCase();
  const inbound: Ctf1155TransferRow[] = [];
  const outbound: Ctf1155TransferRow[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ctfLc) {
      continue;
    }
    let parsed;
    try {
      parsed = erc1155Iface.parseLog(log as Log);
    } catch {
      continue;
    }
    if (!parsed) {
      continue;
    }

    if (parsed.name === "TransferSingle") {
      const { from, to, id, value } = parsed.args as unknown as {
        from: string;
        to: string;
        id: bigint;
        value: bigint;
      };
      if (want.has(to.toLowerCase())) {
        inbound.push(row(id, value));
      }
      if (want.has(from.toLowerCase())) {
        outbound.push(row(id, value));
      }
      continue;
    }

    if (parsed.name === "TransferBatch") {
      const { from, to, ids, values } = parsed.args as unknown as {
        from: string;
        to: string;
        ids: bigint[];
        values: bigint[];
      };
      const toTarget = want.has(to.toLowerCase());
      const fromTarget = want.has(from.toLowerCase());
      if (!toTarget && !fromTarget) {
        continue;
      }
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const value = values[i];
        if (id === undefined || value === undefined) {
          continue;
        }
        if (toTarget) {
          inbound.push(row(id, value));
        }
        if (fromTarget) {
          outbound.push(row(id, value));
        }
      }
    }
  }

  return { inbound, outbound };
}

/**
 * ERC-1155 transfers **to** any of `targets` (subset of {@link extractCtf1155TransfersForTargets}).
 */
export function extractCtf1155InboundToTargets(
  receipt: TransactionReceipt,
  targets: string[]
): Ctf1155TransferRow[] {
  return extractCtf1155TransfersForTargets(receipt, targets).inbound;
}
