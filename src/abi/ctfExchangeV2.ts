import { Interface } from "ethers";

/**
 * V2 `Order` and `matchOrders` / `preapproveOrder` from Polymarket/ctf-exchange-v2
 * (Structs.sol, CTFExchange.sol). EIP-712 domain is version "2" for the exchange.
 */
const orderTuple =
  "tuple(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)";

const fragments = [
  `function matchOrders(bytes32 conditionId,${orderTuple} takerOrder,${orderTuple}[] makerOrders,uint256 takerFillAmount,uint256[] makerFillAmounts,uint256 takerFeeAmount,uint256[] makerFeeAmounts)`,
  `function preapproveOrder(${orderTuple} order)`,
] as const;

export const ctfExchangeV2Interface = new Interface([...fragments]);

export type CtfOrder = {
  salt: bigint;
  maker: string;
  signer: string;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  side: number;
  signatureType: number;
  timestamp: bigint;
  metadata: string;
  builder: string;
  signature: string;
};
