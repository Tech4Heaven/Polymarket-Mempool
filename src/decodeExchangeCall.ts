import { getAddress, type TransactionResponse } from "ethers";
import { ctfExchangeV2Interface, type CtfOrder } from "./abi/ctfExchangeV2.js";

/** `matchOrders` selector on CTF Exchange V2 (Polymarket/ctf-exchange-v2). */
export const SELECTOR_MATCH_ORDERS = "0x3c2b4399";
/** `preapproveOrder` selector. */
export const SELECTOR_PREAPPROVE_ORDER = "0xe3a5ced5";

const knownSelector = (data: string) => {
  const sel = data.slice(0, 10).toLowerCase();
  return sel === SELECTOR_MATCH_ORDERS || sel === SELECTOR_PREAPPROVE_ORDER;
};

export type DecodedMatchOrders = {
  kind: "matchOrders";
  conditionId: string;
  takerOrder: CtfOrder;
  makerOrders: CtfOrder[];
  takerFillAmount: bigint;
  makerFillAmounts: bigint[];
  takerFeeAmount: bigint;
  makerFeeAmounts: bigint[];
};

export type DecodedPreapprove = {
  kind: "preapproveOrder";
  order: CtfOrder;
};

export type DecodedExchangeCall = DecodedMatchOrders | DecodedPreapprove;

function normalizeOrder(raw: CtfOrder): CtfOrder {
  return {
    ...raw,
    maker: getAddress(raw.maker),
    signer: getAddress(raw.signer),
  };
}

/**
 * Decodes CTF Exchange V2 calldata. Other selectors on the same contracts are ignored.
 */
export function decodeCtfExchangeCall(data: string): DecodedExchangeCall | null {
  if (!data || data === "0x" || data.length < 10) {
    return null;
  }
  if (!knownSelector(data)) {
    return null;
  }
  try {
    const parsed = ctfExchangeV2Interface.parseTransaction({ data });
    if (!parsed) {
      return null;
    }
    if (parsed.name === "matchOrders") {
      const [
        conditionId,
        takerOrder,
        makerOrders,
        takerFillAmount,
        makerFillAmounts,
        takerFeeAmount,
        makerFeeAmounts,
      ] = parsed.args;
      return {
        kind: "matchOrders",
        conditionId: String(conditionId),
        takerOrder: normalizeOrder(takerOrder as CtfOrder),
        makerOrders: (makerOrders as CtfOrder[]).map(normalizeOrder),
        takerFillAmount: takerFillAmount as bigint,
        makerFillAmounts: [...(makerFillAmounts as bigint[])],
        takerFeeAmount: takerFeeAmount as bigint,
        makerFeeAmounts: [...(makerFeeAmounts as bigint[])],
      };
    }
    if (parsed.name === "preapproveOrder") {
      const [order] = parsed.args;
      return {
        kind: "preapproveOrder",
        order: normalizeOrder(order as CtfOrder),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Addresses that represent the trader side inside Order structs (EOA, proxy, or safe). */
export function collectOrderParticipantAddresses(decoded: DecodedExchangeCall): string[] {
  if (decoded.kind === "preapproveOrder") {
    const { maker, signer } = decoded.order;
    return maker.toLowerCase() === signer.toLowerCase() ? [maker] : [maker, signer];
  }

  const set = new Set<string>();
  const push = (o: CtfOrder) => {
    set.add(o.maker);
    if (o.maker.toLowerCase() !== o.signer.toLowerCase()) {
      set.add(o.signer);
    }
  };
  push(decoded.takerOrder);
  for (const mo of decoded.makerOrders) {
    push(mo);
  }
  return [...set];
}

export function pendingTxSummary(tx: TransactionResponse): string {
  const to = tx.to ?? "(contract creation)";
  return `${tx.hash} from=${tx.from} to=${to}`;
}
