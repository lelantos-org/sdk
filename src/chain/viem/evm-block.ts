// Resolving Solidity's `block.number` for a given block.
//
// On Ethereum and OP-stack chains (Base, Optimism) `block.number` is the
// block's own height, so a log's `blockNumber` is the value the contract saw.
// On Arbitrum, `block.number` inside the EVM approximates the L1 height, while
// receipts and logs report the unrelated L2 height.
//
// MASP folds `uint32(block.number)` into the deposit digest (`_depositDigest`).
// Replaying the L2 height reconstructs a different digest, and both
// `flushBatch` and `cancelDeposit` revert `DigestMismatch(id)` permanently.
//
// Arbitrum nodes expose the value as a non-standard `l1BlockNumber` field on
// the block. Its absence means the EVM reports the chain's own height.

import type { PublicClient } from "viem";

/** A block as returned by `eth_getBlockByNumber`, plus Arbitrum's extension. */
interface RawBlock {
    l1BlockNumber?: `0x${string}`;
}

/**
 * The value Solidity's `block.number` yields inside `blockNumber`.
 *
 * Returns `blockNumber` unchanged when the node reports no `l1BlockNumber`.
 * Costs one `eth_getBlockByNumber`; do not call it from a polling loop without
 * caching.
 */
export async function evmBlockNumber(
    publicClient: PublicClient,
    blockNumber: bigint,
): Promise<bigint> {
    const block = (await publicClient.request({
        method: "eth_getBlockByNumber",
        params: [`0x${blockNumber.toString(16)}`, false],
    })) as RawBlock | null;

    const l1 = block?.l1BlockNumber;
    // Covers the empty string too, which would otherwise BigInt-parse to 0 and
    // produce a digest that never matches.
    if (!l1) return blockNumber;
    return BigInt(l1);
}
