#!/usr/bin/env node
// Drives one `GenericCallWrapper` execution on the local stack with no calls: unshield, let the
// clone hand the input straight back, re-shield it. Proves the whole path (SDK intent, relayer
// `/v1/generic`, Bundler, wrapper, flush) without depending on any target contract.
//
//   npm run build && node scripts/dev/generic-roundtrip.mjs
//
// ASSET (default 1) is the pool asset id; AMOUNT (default 1000) the circuit units unshielded.

import { genericCall } from "../../dist/entry/internal.js";
import { fundShielded, log, STACK, stackWallet } from "./stack.mjs";

const ASSET = BigInt(process.env.ASSET ?? "1");
const AMOUNT = BigInt(process.env.AMOUNT ?? "1000");
const MIN_GAS = BigInt(process.env.MIN_GAS ?? "100000");
// Fresh per run, so earlier runs' notes are not this wallet's.
const NSK = BigInt(process.env.NSK ?? `0x${Date.now().toString(16)}a11ce`);

const { wallet, registry, relayer } = await stackWallet(NSK);
try {
    if (!registry.genericCallWrapperAddress) {
        throw new Error("the registry publishes no genericCallWrapperAddress on this chain");
    }
    log("wrapper", registry.genericCallWrapperAddress, "bundler", relayer.relayerAddress);

    // Enough for the unshield, its fees and a relayer fee paid in the same asset.
    log(`shielding ${AMOUNT * 4n} units of asset ${ASSET}`);
    await fundShielded(wallet, registry, ASSET, AMOUNT * 4n);
    log("shielded balance", (await wallet.balance(ASSET)).total.toString());

    log(`generic execution: ${AMOUNT} units out, 0 calls, minGas ${MIN_GAS}`);
    const res = await genericCall(wallet, {
        asset: ASSET,
        amount: { gross: AMOUNT },
        calls: [],
        minGas: MIN_GAS,
    });
    log("landed", res.txHash);
    log("output note", res.outputCommitments[0], "credit", res.outputCredits[0].toString());
    log("refund note", res.refundCommitment, "(must not appear)");

    const settled = await wallet.awaitCommitments(res.outputCommitments, { timeoutMs: 180_000 });
    if (settled.status !== "seen") {
        throw new Error(`output note did not appear: ${settled.status}`);
    }
    const refund = await wallet.awaitCommitments([res.refundCommitment], { timeoutMs: 5_000 });
    if (refund.status === "seen") throw new Error("the refund note appeared: the call leg failed");
    log("output note flushed; shielded balance", (await wallet.balance(ASSET)).total.toString());
    log(`OK on chain ${STACK.chainId}`);
} finally {
    await wallet.dispose();
}
