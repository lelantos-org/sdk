// Funding the unshielded mechanism's throwaway payer: which address pays, and topping it up by
// unshielding.

import { sleep } from "../core/async.js";
import {
    type AssetId,
    branded,
    type CircuitAmount,
    type EvmAddress,
    type TokenAmount,
} from "../core/brand.js";
import { safeCall } from "../core/callbacks.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import type { AssetInfo } from "../wallet/assets/index.js";
import type { OpOptions, SpendPhase } from "../wallet/types/options.js";
import { hostPayerIndex } from "./ephemeral.js";
import { unsupported } from "./requirements.js";

const log = getLogger("lelantos:x402:unshielded");

/** Message prefix, and the label the unshielded mechanism is known by. */
export const SCOPE = "unshielded";

/**
 * Ephemeral payer slot and how it was chosen.
 *
 * `"shared"` means no host was available, so every such payment uses the same
 * slot and therefore the same publicly-funded EVM address. Provenance is
 * carried so that case can be reported.
 */
interface PayerSlot {
    index: number;
    provenance: "pinned" | "host" | "shared";
}

/** Slot used when nothing identifies the resource. See `PayerSlot`. */
const SHARED_PAYER_INDEX = 0;

export function resolvePayerSlot(pinned: number | undefined, host: string | undefined): PayerSlot {
    if (pinned !== undefined) return { index: pinned, provenance: "pinned" };
    if (host) return { index: hostPayerIndex(host), provenance: "host" };
    return { index: SHARED_PAYER_INDEX, provenance: "shared" };
}

/**
 * Unshield into `payer` when its balance does not cover `needed`. Withdraws a
 * multiple so subsequent payments need no proof.
 */
export async function ensureFunded(
    wallet: WalletApi,
    payer: EvmAddress,
    asset: AssetInfo,
    needed: TokenAmount,
    opts: {
        topUpMultiple: bigint;
        onPhase?: OpOptions<SpendPhase>["onPhase"];
        pollMs: number;
        maxPolls: number;
        onTopUp?:
            | ((info: { payer: EvmAddress; asset: AssetId; amount: CircuitAmount }) => void)
            | undefined;
    },
): Promise<void> {
    const { tokenBalanceOf } = wallet.chain;
    if (!tokenBalanceOf) {
        throw unsupported(
            SCOPE,
            "chain adapter has no `tokenBalanceOf`, so the payer balance cannot be " +
                "checked — pass a fuller adapter or use the shielded mechanism",
        );
    }
    const balanceOf = () => tokenBalanceOf.call(wallet.chain, asset.token, payer);

    const held = await balanceOf();
    if (held >= needed) return;

    // A withdraw's amount is gross: the protocol fee is deducted from it, so a
    // top-up of exactly `needed` arrives short. A multiple absorbs the fee and
    // amortises the proof across later payments.
    const shortfall = needed - held;
    const target = branded<CircuitAmount>(ceilDiv(shortfall * opts.topUpMultiple, asset.scale));

    log.info("topping up ephemeral payer", {
        payer,
        asset: asset.id.toString(),
        circuitUnits: target.toString(),
    });
    // Reported before the withdraw so the caller is notified even if the poll
    // below times out.
    safeCall("onTopUp", opts.onTopUp, { payer, asset: asset.id, amount: target });
    await wallet.withdraw({
        recipient: payer,
        gross: target,
        asset: asset.id,
        onPhase: opts.onPhase,
    });

    for (let i = 0; i < opts.maxPolls; i++) {
        await sleep(opts.pollMs);
        if ((await balanceOf()) >= needed) return;
    }
    throw unsupported(
        SCOPE,
        `withdrawal to ${payer} did not land within ` +
            `${(opts.pollMs * opts.maxPolls) / 1000}s. The funds are not lost — ` +
            `retry once the relayer has flushed.`,
    );
}

/**
 * ERC-20 address → MASP asset, chain-verified. Probes `candidates` when given; otherwise every
 * registered asset (the relayer's list) whose token matches, each verified against the pool.
 */
export async function resolveAsset(
    wallet: Pick<WalletApi, "asset" | "assets">,
    token: EvmAddress,
    candidates: readonly AssetId[] | undefined,
): Promise<AssetInfo> {
    const want = token.toLowerCase();
    const ids =
        candidates ??
        (await wallet.assets()).filter((a) => a.token.toLowerCase() === want).map((a) => a.id);
    for (const id of ids) {
        // Verified: the listed token is advisory; the pool's entry decides.
        const info = await wallet.asset(id);
        if (info.token.toLowerCase() === want) return info;
    }
    throw unsupported(
        SCOPE,
        candidates
            ? `token ${token} is not among the MASP assets checked (${candidates.join(", ")}). ` +
                  "Pass `assetIds` naming the registry id that backs it."
            : `token ${token} is not a registered MASP asset.`,
    );
}

export function ceilDiv(a: bigint, b: bigint): bigint {
    return (a + b - 1n) / b;
}
