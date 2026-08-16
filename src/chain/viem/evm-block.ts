// Resolving Solidity's `block.number` for a given block.
//
// On Ethereum and OP-stack chains (Base, Optimism) `block.number` is the
// block's own height, so a log's `blockNumber` is the value the contract saw.
//
// Arbitrum breaks that assumption: inside the EVM, `block.number` returns an
// approximation of the *L1* height, while receipts and logs report the L2
// height. The two are unrelated magnitudes — an L2 block around 495,000,000
// sits at an L1 height around 25,700,000.
//
// This matters because MASP folds `uint32(block.number)` into the deposit
// digest (`_depositDigest`). Replaying the L2 height reconstructs a different
// digest, and both `flushBatch` and `cancelDeposit` revert
// `DigestMismatch(id)` — permanently, since nothing about the deposit changes.
//
// Arbitrum nodes expose the value as a non-standard `l1BlockNumber` field on
// the block. Its absence is the signal that the chain's own height is what the
// EVM reports, which covers every other chain without needing a chain-id
// allowlist that a future rollup would fall off.

import type { PublicClient } from "viem";

/** A block as returned by `eth_getBlockByNumber`, plus Arbitrum's extension. */
interface RawBlock {
    l1BlockNumber?: `0x${string}`;
}

/**
 * The value Solidity's `block.number` yields inside `blockNumber`.
 *
 * Returns `blockNumber` unchanged when the node reports no `l1BlockNumber`,
 * which is the case on every non-Arbitrum chain.
 *
 * Costs one `eth_getBlockByNumber`. Callers are on the deposit-cancel path,
 * which is rare; do not put this in a polling loop without caching.
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
    // Guard the empty string too: a node that returns "" would otherwise
    // BigInt-parse to 0 and silently produce a digest that never matches.
    if (!l1) return blockNumber;
    return BigInt(l1);
}
