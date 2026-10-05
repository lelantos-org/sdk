#!/usr/bin/env node
// Claims a handle on the local stack through `wallet.registerName`, then reads it back from the
// registrar. Run it twice with one label to see the second registration refused before proving.
//
//   npm run build && node scripts/dev/register-name.mjs mehow
//
// LABEL may also be given as the first argument. NSK selects the account (default: fresh per run).

import { createPublicClient, http } from "viem";
import { readNameRecord } from "../../dist/entry/advanced.js";
import { PUBLISHED_DIVERSIFIER_INDEX } from "../../dist/entry/primitives.js";
import { fundShielded, log, plainAssetOf, STACK, stackWallet } from "./stack.mjs";

const LABEL = process.argv[2] ?? process.env.LABEL;
if (!LABEL) throw new Error("usage: register-name.mjs <label>");
const NSK = BigInt(process.env.NSK ?? `0x${Date.now().toString(16)}a11ce`);

const { wallet, registry } = await stackWallet(NSK);
try {
    const registrar = registry.nameRegistrarAddress;
    if (!registrar) throw new Error("the registry publishes no nameRegistrarAddress on this chain");
    if (!wallet.capabilities.registerName) {
        throw new Error("wallet.capabilities.registerName is false");
    }
    const client = createPublicClient({ transport: http(STACK.rpcUrl) });
    const fee = await wallet.chain.nameFee(registrar);
    log("registrar", registrar, "fee", fee.amount.toString(), "of", fee.token);

    // The wallet has no asset list on the stack (the registry serves it, not the relayer), so the
    // fee token's plain pool asset is found there and named by id.
    const listed = await plainAssetOf(fee.token);
    if (!listed) throw new Error(`the registry lists no plain asset for ${fee.token}`);
    const assetId = BigInt(listed.assetId);
    // The fee, three times over, plus fees.
    const funding = (fee.amount * 3n) / BigInt(listed.scale) + 1_000n;
    log(`shielding ${funding} units of asset ${assetId}`);
    const asset = await fundShielded(wallet, registry, assetId, funding);

    const published = await wallet.publishedAddress();
    log("registering", LABEL, "->", `${published.slice(0, 24)}…`);
    const res = await wallet.registerName({ label: LABEL, asset: asset.id });
    log("landed", res.txHash, "registered:", res.registered);

    const record = await readNameRecord(client, registrar, res.label);
    log(
        "record",
        JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
    if (res.registered) {
        if (record.value !== published) throw new Error("the registrar holds another value");
        if (record.value !== (await wallet.addressAt(PUBLISHED_DIVERSIFIER_INDEX))) {
            throw new Error("the value is not the address at the published index");
        }
        if (record.controller.toLowerCase() !== res.controller.toLowerCase()) {
            throw new Error("the registrar holds another controller");
        }
    }
    const note = res.registered ? res.changeCommitment : res.refundCommitment;
    const settled = await wallet.awaitCommitments([note], { timeoutMs: 180_000 });
    log(res.registered ? "change note" : "refund note", settled.status);
    log(
        res.registered
            ? `OK: ${res.label} is registered`
            : "refunded: the label was not registered",
    );
} finally {
    await wallet.dispose();
}
