// One-time Permit2 AllowanceTransfer setup, so later deposits pull with no per-deposit signature.
// Backs `wallet.setupDepositAllowance`.

import { supportsAllowanceBatch, supportsSigning } from "../../chain/port.js";
import { branded, type EvmAddress, type Hex32, type TokenAmount } from "../../core/brand.js";
import { safeCall } from "../../core/callbacks.js";
import { unixNow } from "../../core/time.js";
import { NoEvmAccountError, UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { WalletContext } from "../context.js";
import type { AllowanceSetupOptions, AllowanceSetupProgress } from "../types/options.js";

/**
 * The default window cap: `type(uint160).max`, which Permit2 treats as unlimited and never
 * decrements, so the window does not drain and `expiration` is its only bound.
 */
export const ALLOWANCE_CAP = (1n << 160n) - 1n;
/** The ERC-20 → Permit2 approval: unlimited, as Permit2's own pull is what each deposit bounds. */
const MAX_UINT256 = (1n << 256n) - 1n;
/** Default window lifetime: a quarter, the whole bound on an unlimited grant. */
const ALLOWANCE_EXPIRY_SECS = 90 * 24 * 3600;
/** Default deadline of the one `PermitBatch` signature. */
const SIG_DEADLINE_SECS = 30 * 60;
/** Permit2 stores `expiration` as `uint48`. */
const UINT48_MAX = 2 ** 48 - 1;

/**
 * Grant the pool a Permit2 window for every token `args.assets` names.
 *
 * Per token whose ERC-20 → Permit2 approval is below `cap`, one approval (sequential: wallets
 * serialise prompts, and parallel sends race the nonce); then one `PermitBatch` signature over every
 * token, with nonces read after the approvals, and one `permit` transaction. `onProgress` fires
 * `wallet` before each prompt and `confirming` with the transaction hash.
 */
export async function setupDepositAllowance(
    ctx: WalletContext,
    args: AllowanceSetupOptions,
): Promise<void> {
    const chain = ctx.cfg.chain;
    if (!supportsSigning(chain))
        throw new NoEvmAccountError({ operation: "setupDepositAllowance" });
    if (
        !supportsAllowanceBatch(chain) ||
        !chain.permit2Address ||
        !chain.tokenApprove ||
        !chain.tokenAllowance
    ) {
        throw new UnsupportedOperationError("setupDepositAllowance", [
            "chain.signPermit2AllowanceBatch",
            "chain.permit2PermitAllowanceBatch",
            "chain.tokenApprove",
            "chain.tokenAllowance",
            "chain.permit2Address",
        ]);
    }
    const now = unixNow();
    const { cap, expiration, deadline } = checkTerms(args, now);
    const { signal } = args;
    const progress = (p: AllowanceSetupProgress) => safeCall("onProgress", args.onProgress, p);

    // Assets sharing a token are one window: Permit2 keys it by `(owner, token, spender)`.
    const tokens: EvmAddress[] = [];
    for (const ref of args.assets) {
        const { token } = await ctx.assets.resolveVerified(ref);
        if (!tokens.some((t) => t.toLowerCase() === token.toLowerCase())) tokens.push(token);
    }
    if (tokens.length === 0) return;
    signal?.throwIfAborted();

    // Bound, not destructured: adapter methods read `this`.
    const tokenAllowance = chain.tokenAllowance.bind(chain);
    const tokenApprove = chain.tokenApprove.bind(chain);
    const owner = await chain.payerAddress();
    const masp = await chain.maspAddress();
    const permit2 = chain.permit2Address();

    // Pass 1: ERC-20 → Permit2, one transaction per token below the cap.
    const allowances = await Promise.all(tokens.map((t) => tokenAllowance(t, owner, permit2)));
    const needApproval = tokens.filter((_, i) => allowances[i]! < cap);
    for (const [i, token] of needApproval.entries()) {
        signal?.throwIfAborted();
        const at = { token, index: i + 1, total: needApproval.length };
        progress({ step: "approving", status: "wallet", ...at });
        await tokenApprove(token, permit2, branded<TokenAmount>(MAX_UINT256), (txHash: Hex32) =>
            progress({ step: "approving", status: "confirming", txHash, ...at }),
        );
    }

    // Pass 2: one signature over every window. Nonces are read after the approvals, as close to
    // the signature as possible: Permit2 reverts the whole batch on one stale entry.
    signal?.throwIfAborted();
    const windows = await Promise.all(tokens.map((t) => chain.permit2Allowance(t, owner, masp)));
    const permit = {
        details: tokens.map((token, i) => ({
            token,
            amount: cap,
            expiration,
            nonce: windows[i]!.nonce,
        })),
        spender: masp,
        sigDeadline: deadline,
    };
    progress({ step: "signing", status: "wallet" });
    const { signature } = await chain.signPermit2AllowanceBatch(permit);

    // Pass 3: one transaction establishes every window.
    signal?.throwIfAborted();
    progress({ step: "permitting", status: "wallet" });
    await chain.permit2PermitAllowanceBatch({ owner, permit, signature }, (txHash: Hex32) =>
        progress({ step: "permitting", status: "confirming", txHash }),
    );
}

/** The window terms, defaulted and checked before any I/O. */
function checkTerms(
    args: AllowanceSetupOptions,
    now: number,
): { cap: bigint; expiration: number; deadline: bigint } {
    if (!Array.isArray(args.assets)) {
        throw new InvalidArgumentError("setupDepositAllowance: assets must be an array", {
            argument: "assets",
        });
    }
    const cap = args.cap ?? ALLOWANCE_CAP;
    if (typeof cap !== "bigint" || cap <= 0n || cap > ALLOWANCE_CAP) {
        throw new InvalidArgumentError(
            "setupDepositAllowance: cap must be a bigint in 1..2^160-1 base units",
            { argument: "cap" },
        );
    }
    const expiration = args.expiration ?? now + ALLOWANCE_EXPIRY_SECS;
    if (!Number.isInteger(expiration) || expiration <= now || expiration > UINT48_MAX) {
        throw new InvalidArgumentError(
            "setupDepositAllowance: expiration must be future unix seconds",
            { argument: "expiration" },
        );
    }
    const deadline = args.deadline ?? BigInt(now + SIG_DEADLINE_SECS);
    if (typeof deadline !== "bigint" || deadline <= BigInt(now)) {
        throw new InvalidArgumentError(
            "setupDepositAllowance: deadline must be a future bigint of unix seconds",
            { argument: "deadline" },
        );
    }
    return { cap, expiration, deadline };
}
