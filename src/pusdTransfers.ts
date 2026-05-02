import { Interface, type Log, type TransactionReceipt } from "ethers";
import { PUSD_TOKEN } from "./contracts.js";

const erc20Iface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

/** Sum of pUSD (6 decimals) received by vs sent from any target address in this receipt. */
export function aggregatePusdForTargets(
  receipt: TransactionReceipt,
  targets: string[]
): { received: bigint; sent: bigint } {
  const want = new Set(targets.map((a) => a.toLowerCase()));
  const tokenLc = PUSD_TOKEN.toLowerCase();
  let received = 0n;
  let sent = 0n;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenLc) {
      continue;
    }
    let parsed;
    try {
      parsed = erc20Iface.parseLog(log as Log);
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== "Transfer") {
      continue;
    }
    const { from, to, value } = parsed.args as unknown as {
      from: string;
      to: string;
      value: bigint;
    };
    if (want.has(to.toLowerCase())) {
      received += value;
    }
    if (want.has(from.toLowerCase())) {
      sent += value;
    }
  }

  return { received, sent };
}
