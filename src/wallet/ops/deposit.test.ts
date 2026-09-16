import { describe, expect, it } from "vitest";
import type { ChainAdapter } from "../../chain/port.js";
import type { AssetEntry, Permit2SignArgs } from "../../chain/types.js";
import {
    type AssetId,
    assetId,
    branded,
    circuitAmount,
    type EvmAddress,
    type Hex32,
    type TokenAmount,
} from "../../core/brand.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { isWalletError } from "../../errors/guard.js";
import { decodeNotePayload, stripClueBitsPrefix } from "../../notes/codec.js";
import { decryptNote } from "../../notes/encrypt.js";
import { computePiHash } from "../../protocol/abi-hash.js";
import type { AuxOutput, DepositRequest, Permit2Sig } from "../../protocol/deposit-request.js";
import { RAY } from "../../protocol/units.js";
import { DEPOSIT_TX, minedDeposit } from "../../test-utils/deposit.js";
import { estimateOf, identity } from "../../test-utils/estimate.js";
import type { WalletContext } from "../context.js";
import type { DepositPhase, PhaseInfo } from "../types/options.js";
import { executeDeposit, quoteDeposit } from "./deposit.js";

// Paying a deposit's relayer note in a chosen asset.
//
// The pool branches on `feeAssetId`: a note in the deposit asset (or of zero
// value) rides the single-token pull, one in another asset is a second pull
// under a two-token permit. These assert the request, the fee note, the signed
// ceilings and the strategy agree on which branch a deposit takes, since any
// disagreement reverts on chain (`BadMaxFee`, `InvalidSigner`, a short
// allowance) or strands the escrow (`DigestMismatch` at flush).

const USDC = assetId(1n);
const WETH = assetId(2n);
const YIELD_USDC = assetId(3n);

const PAYER = branded<EvmAddress>("0x00000000000000000000000000000000000000aa");
const MASP = branded<EvmAddress>("0x0000000000000000000000000000000000000a11");
const ADAPTER = branded<EvmAddress>("0x00000000000000000000000000000000000ada9e");
const TOKEN_USDC = branded<EvmAddress>("0x000000000000000000000000000000000000c0c0");
const TOKEN_WETH = branded<EvmAddress>("0x000000000000000000000000000000000000e7e7");
const PERMIT2 = branded<EvmAddress>("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const TX = DEPOSIT_TX;

/** Registry: USDC at scale 10, WETH at scale 1000, and a yield id over USDC's token. */
const ENTRIES: Record<string, AssetEntry> = {
    "1": entry(TOKEN_USDC, 10n, false),
    "2": entry(TOKEN_WETH, 1_000n, false),
    "3": entry(TOKEN_USDC, 10n, true),
};

function entry(token: EvmAddress, scale: bigint, yieldEnabled: boolean) {
    return {
        token,
        scale,
        disabled: false,
        depositBps: 20n,
        withdrawBps: 0n,
        index: RAY,
        yieldEnabled,
    };
}

interface Recorded {
    signed: Permit2SignArgs[];
    submitted: {
        deposit: DepositRequest;
        aux: AuxOutput;
        feeAux: AuxOutput;
        permit2: Permit2Sig;
    }[];
    native: { deposit: DepositRequest; value: bigint }[];
    authorized: DepositRequest[];
}

/**
 * A wallet whose chain records every signature and submission, and whose
 * relayer quotes `quotes` circuit units per asset (none: it charges nothing).
 */
async function makeCtx(opts: {
    quotes?: Record<string, bigint>;
    /** Permit2 allowance per token; absent tokens have none. */
    allowances?: Record<string, bigint>;
    /** ERC-20 → Permit2 approval per token. Default: unlimited. */
    erc20?: Record<string, bigint>;
    /** Public balance per token (and `"native"`). Absent: unreadable. */
    balances?: Record<string, bigint>;
}) {
    const P = await Poseidon.build();
    const J = await Jubjub.build();
    const me = await identity(J);
    const relayer = await identity(J);
    const rec: Recorded = { signed: [], submitted: [], native: [], authorized: [] };
    const far = Math.floor(Date.now() / 1000) + 86_400;

    const chain = {
        payerAddress: async () => PAYER,
        maspAddress: async () => MASP,
        nativeAdapterAddress: () => ADAPTER,
        fetchAsset: async (id: AssetId) => ENTRIES[id.toString()]!,
        permit2Nonce: async () => 1n,
        signPermit2: async (args: Permit2SignArgs): Promise<Permit2Sig> => {
            rec.signed.push(args);
            return {
                nonce: args.nonce,
                deadline: args.deadline,
                maxTotal: args.maxTotal,
                maxFee: args.maxFee ?? 0n,
                signature: "0x",
            };
        },
        submitDeposit: async (
            a: Recorded["submitted"][number] & { onSent?: (h: Hex32) => void },
        ) => {
            rec.submitted.push(a);
            a.onSent?.(TX);
            return minedDeposit(a.deposit, { id: 9n });
        },
        submitDepositNative: async (a: {
            deposit: DepositRequest;
            value: bigint;
            onSent?: (h: Hex32) => void;
        }) => {
            rec.native.push(a);
            a.onSent?.(TX);
            return minedDeposit(a.deposit, { id: 9n });
        },
        submitDepositAuthorized: async (a: {
            deposit: DepositRequest;
            onSent?: (h: Hex32) => void;
        }) => {
            rec.authorized.push(a.deposit);
            a.onSent?.(TX);
            return minedDeposit(a.deposit, { id: 9n });
        },
        cancelDelay: async () => 7_200,
        permit2Address: () => PERMIT2,
        tokenAllowance: async (token: EvmAddress) =>
            branded<TokenAmount>(opts.erc20?.[token] ?? 1n << 255n),
        ...(opts.balances
            ? {
                  tokenBalanceOf: async (token: EvmAddress) =>
                      branded<TokenAmount>(opts.balances![token] ?? 0n),
                  nativeBalance: async () => opts.balances!.native ?? 0n,
              }
            : {}),
        permit2Allowance: async (token: EvmAddress) => ({
            amount: branded<TokenAmount>(opts.allowances?.[token] ?? 0n),
            expiration: far,
            nonce: 0,
        }),
        permit2PermitAllowance: async () => ({ txHash: TX }),
        signPermit2Allowance: async () => ({ signature: "0x" }),
        permit2PermitAllowanceBatch: async () => ({ txHash: TX }),
        signPermit2AllowanceBatch: async () => ({ signature: "0x" }),
        tokenApprove: async () => ({ txHash: TX }),
    } as unknown as ChainAdapter;

    const estimate = estimateOf(opts.quotes ? relayer.address : undefined, opts.quotes);

    const ctx = {
        P,
        J,
        address: me.address,
        cfg: { chainId: 31337n, chain, submitter: { estimate: async () => estimate } },
        assets: {
            resolveVerified: async (ref: unknown) => {
                const id = BigInt(ref as bigint);
                const e = ENTRIES[id.toString()]!;
                return {
                    id: assetId(id),
                    ...e,
                    index: 10n ** 27n,
                    // A yield asset whose venue has earned nothing: one unit is
                    // worth `scale` tokens, so its quote is plain but defined.
                    ...(e.yieldEnabled ? { rate: { gross: e.scale, supply: 1n } } : {}),
                };
            },
        },
    } as unknown as WalletContext;

    return { ctx, rec, J, me, relayer };
}

/** The fee note's plaintext, decrypted as its addressee would. */
function openFeeNote(J: Jubjub, ivk: bigint, aux: AuxOutput) {
    const plain = decryptNote({
        J,
        ivk,
        note: {
            epk: J.packPoint([aux.ephPubX, aux.ephPubY]),
            ciphertext: stripClueBitsPrefix(aux.ciphertext).body,
        },
    });
    expect(plain, "fee note does not decrypt for its addressee").not.toBeNull();
    return decodeNotePayload(plain!);
}

/** Nothing reached the chain: no signature, and no submission on any path. */
function expectNothingSent(rec: Recorded) {
    expect(rec.signed).toHaveLength(0);
    expect(rec.submitted).toHaveLength(0);
    expect(rec.native).toHaveLength(0);
    expect(rec.authorized).toHaveLength(0);
}

describe("deposit relayer fee asset", () => {
    it("pays the note in another asset: request, note, commitment and two-token permit", async () => {
        const { ctx, rec, J, relayer } = await makeCtx({ quotes: { "1": 3n, "2": 7n } });

        await executeDeposit(ctx, { amount: circuitAmount(1_000n), asset: USDC, feeAsset: WETH });

        const { deposit, aux, feeAux, permit2 } = rec.submitted[0]!;
        expect(deposit.publicAssetId).toBe(USDC);
        expect(deposit.feeAssetId).toBe(WETH);
        // WETH's quote, not USDC's.
        expect(deposit.feeIn).toBe(7n);

        expect(openFeeNote(J, relayer.ivk, feeAux)).toMatchObject({ asset: WETH, value: 7n });
        // The flush circuit opens `feeCvDep` under the fee leaf's asset.
        expect(deposit.feeCvDep).toEqual(
            J.valueCommit(7n, J.hashToAssetGen(WETH), deposit.feeRcv).slice(0, 2),
        );

        // [USDC: principal + 0.2% fee, WETH: 7 units at scale 1000], bound to
        // the request actually submitted.
        expect(rec.signed[0]).toMatchObject({
            token: TOKEN_USDC,
            maxTotal: 10_020n,
            feeToken: TOKEN_WETH,
            maxFee: 7_000n,
            piHash: computePiHash(deposit, aux, feeAux),
        });
        expect(permit2.maxFee).toBe(7_000n);
    });

    it.each([
        ["omitted", undefined],
        ["the deposit asset", USDC],
    ])("keeps a fee asset %s on the single-token permit", async (_, feeAsset) => {
        const { ctx, rec, J, relayer } = await makeCtx({ quotes: { "1": 3n, "2": 7n } });

        await executeDeposit(ctx, { amount: circuitAmount(1_000n), asset: USDC, feeAsset });

        const { deposit, feeAux, permit2 } = rec.submitted[0]!;
        expect(deposit.feeAssetId).toBe(USDC);
        expect(openFeeNote(J, relayer.ivk, feeAux)).toMatchObject({ asset: USDC, value: 3n });
        // One ceiling over principal, protocol fee and the note: 10_000 + 20 + 30.
        expect(rec.signed[0]!.maxTotal).toBe(10_050n);
        expect(rec.signed[0]).not.toHaveProperty("feeToken");
        expect(rec.signed[0]).not.toHaveProperty("maxFee");
        expect(permit2.maxFee).toBe(0n);
    });

    it("self-pads a zero fee in the deposit asset and names asset 0", async () => {
        // No shielded fee address: the relayer subsidises deposits.
        const { ctx, rec, J, me } = await makeCtx({});

        await executeDeposit(ctx, { amount: circuitAmount(1_000n), asset: USDC, feeAsset: WETH });

        const { deposit, feeAux } = rec.submitted[0]!;
        // A zero-value leaf's asset is 0 in the circuit; anything else reverts
        // `FeeAssetMustBeZero`.
        expect(deposit.feeIn).toBe(0n);
        expect(deposit.feeAssetId).toBe(0n);
        // Still the ordinary self-pad scanners discard, in the deposit asset.
        expect(openFeeNote(J, me.ivk, feeAux)).toMatchObject({ asset: USDC, value: 0n });
        expect(deposit.feeCvDep).toEqual(
            J.valueCommit(0n, J.hashToAssetGen(USDC), deposit.feeRcv).slice(0, 2),
        );
        // Single-token: `isSameFeeAsset` holds for any zero fee.
        expect(rec.signed[0]).not.toHaveProperty("feeToken");
        expect(rec.signed[0]!.maxTotal).toBe(10_020n);
    });

    it.each([
        // `NativeAdapter` pulls the wrapped coin alone.
        ["another asset on a native deposit", { asset: WETH, feeAsset: USDC, native: true }],
        // The pool refuses it with `FeeAssetUnsupported`.
        ["a yield asset other than the deposit's", { asset: USDC, feeAsset: YIELD_USDC }],
    ])("refuses %s, before signing", async (_, opts) => {
        const { ctx, rec } = await makeCtx({ quotes: { "1": 3n, "2": 7n, "3": 3n } });
        const err = await executeDeposit(ctx, { amount: circuitAmount(1_000n), ...opts }).catch(
            (e: unknown) => e,
        );

        expect(isWalletError(err, "INVALID_ARGUMENT")).toBe(true);
        expect((err as { argument?: string }).argument).toBe("feeAsset");
        expectNothingSent(rec);
    });

    it("sends a native deposit's whole pull as msg.value when the fee is in the coin", async () => {
        const { ctx, rec } = await makeCtx({ quotes: { "2": 7n } });
        await executeDeposit(ctx, {
            amount: circuitAmount(10n),
            asset: WETH,
            feeAsset: WETH,
            native: true,
        });
        expect(rec.native[0]!.deposit.feeAssetId).toBe(WETH);
        // 10_000 principal + 20 protocol fee + 7_000 note.
        expect(rec.native[0]!.value).toBe(17_020n);
    });

    it("accepts a yield fee asset that is the deposit asset", async () => {
        const { ctx, rec } = await makeCtx({ quotes: { "3": 3n } });
        await executeDeposit(ctx, {
            amount: circuitAmount(1_000n),
            asset: YIELD_USDC,
            feeAsset: YIELD_USDC,
        });
        expect(rec.submitted[0]!.deposit.feeAssetId).toBe(YIELD_USDC);
        expect(rec.signed[0]).not.toHaveProperty("feeToken");
    });

    it("pulls a plain fee id over a yield principal's token as a second entry", async () => {
        const { ctx, rec } = await makeCtx({ quotes: { "1": 3n } });
        await executeDeposit(ctx, {
            amount: circuitAmount(1_000n),
            asset: YIELD_USDC,
            feeAsset: USDC,
        });
        // Decided by id, not token: the two entries name one ERC-20. The
        // principal is quoted without the note (ceil(1_002 units) + 50 bps).
        expect(rec.submitted[0]!.deposit.feeAssetId).toBe(USDC);
        expect(rec.signed[0]).toMatchObject({
            token: TOKEN_USDC,
            maxTotal: 10_070n,
            feeToken: TOKEN_USDC,
            maxFee: 30n,
        });
    });
});

// A Permit2 allowance is per token, so a window for the deposit token alone
// does not cover a relayer note paid in another one.
describe("deposit strategy with a separate fee token", () => {
    const deposit = { amount: circuitAmount(1_000n), asset: USDC, feeAsset: WETH };

    it("uses the allowance path only when both tokens are covered", async () => {
        const { ctx, rec } = await makeCtx({
            quotes: { "2": 7n },
            allowances: { [TOKEN_USDC]: 10_020n, [TOKEN_WETH]: 7_000n },
        });
        const res = await executeDeposit(ctx, deposit);
        expect(res.strategy).toBe("allowance");
        expect(rec.authorized[0]!.feeAssetId).toBe(WETH);
        expect(rec.signed).toHaveLength(0);
    });

    it.each([
        ["has no window", { [TOKEN_USDC]: 1n << 100n }],
        ["is short by a unit", { [TOKEN_USDC]: 10_020n, [TOKEN_WETH]: 6_999n }],
    ])("falls back to the witness path when the fee token %s", async (_, allowances) => {
        const { ctx, rec } = await makeCtx({ quotes: { "2": 7n }, allowances });
        const res = await executeDeposit(ctx, deposit);
        expect(res.strategy).toBe("witness");
        expect(rec.signed[0]!.feeToken).toBe(TOKEN_WETH);
    });

    it("needs one window covering both pulls when they share a token", async () => {
        const run = async (allowance: bigint) => {
            const { ctx } = await makeCtx({
                quotes: { "1": 3n },
                allowances: { [TOKEN_USDC]: allowance },
            });
            const res = await executeDeposit(ctx, {
                amount: circuitAmount(1_000n),
                asset: YIELD_USDC,
                feeAsset: USDC,
            });
            return res.strategy;
        };
        // Principal ceiling 10_070 plus the fee's 30, from one allowance.
        expect(await run(10_100n)).toBe("allowance");
        expect(await run(10_099n)).toBe("witness");
    });
});

// The result a deposit returns: fees per party, what was pulled per asset, and an escrow complete
// enough to cancel or await after a reload.
describe("deposit result", () => {
    async function run(
        opts: Parameters<typeof makeCtx>[0],
        args: Omit<Parameters<typeof executeDeposit>[1], "amount"> & { amount?: bigint },
    ) {
        const made = await makeCtx(opts);
        const phases: [DepositPhase, PhaseInfo][] = [];
        const res = await executeDeposit(
            made.ctx,
            { amount: circuitAmount(args.amount ?? 1_000n), ...args } as never,
            {
                opId: "op-1",
                op: "deposit",
                phase: (p, txHash) =>
                    phases.push([p, txHash ? { opId: "op-1", txHash } : { opId: "op-1" }]),
            },
        );
        return { ...made, res, phases };
    }

    it("same asset: protocol and relayer fees, one pull, a complete escrow", async () => {
        const { res, rec, me, phases } = await run({ quotes: { "1": 3n } }, { asset: USDC });
        const { deposit } = rec.submitted[0]!;

        expect(res).toMatchObject({
            kind: "deposit",
            opId: "op-1",
            txHash: TX,
            strategy: "witness",
            native: false,
            recipient: me.address.toLowerCase(),
            amount: { asset: USDC, amount: 1_000n, baseUnits: 10_000n },
        });
        // 0.2% of 10_000 base units, on top; the relayer's 3 units at scale 10.
        expect(res.fees).toEqual({
            protocol: { asset: USDC, amount: 2n, baseUnits: 20n },
            relayer: { asset: USDC, amount: 3n, baseUnits: 30n },
        });
        expect(res.pulled).toEqual([{ asset: USDC, amount: 1_005n, baseUnits: 10_050n }]);

        expect(res.escrow).toEqual({
            depositId: 9n,
            native: false,
            asset: USDC,
            commitment: deposit.outCm,
            cancelInputs: {
                publicIn: 1_000n,
                cm: deposit.outCm,
                cvDep: deposit.cvDep,
                publicAssetId: USDC,
                feeBpsAtSubmit: 20,
                payer: PAYER,
                submittedAt: 1_000,
                feeIn: 3n,
                feeAssetId: USDC,
                feeCm: deposit.feeCm,
                feeCvDep: deposit.feeCvDep,
            },
            // The mined block plus the pool's live cancel delay.
            cancellableAtBlock: 8_200,
        });
        expect(res.commitments).toEqual([deposit.outCm]);
        expect(res.ownCommitments).toEqual([deposit.outCm]);
        expect(Object.isFrozen(res) && Object.isFrozen(res.escrow)).toBe(true);
        expect(phases).toEqual([
            ["preparing", { opId: "op-1" }],
            ["signing", { opId: "op-1" }],
            ["submitting", { opId: "op-1" }],
            ["broadcast", { opId: "op-1", txHash: TX }],
            ["confirmed", { opId: "op-1", txHash: TX }],
        ]);
    });

    it("cross asset: the relayer's fee in its asset, pulled on its own", async () => {
        const { res, rec } = await run({ quotes: { "2": 7n } }, { asset: USDC, feeAsset: WETH });
        expect(res.fees).toEqual({
            protocol: { asset: USDC, amount: 2n, baseUnits: 20n },
            relayer: { asset: WETH, amount: 7n, baseUnits: 7_000n },
        });
        expect(res.pulled).toEqual([
            { asset: USDC, amount: 1_002n, baseUnits: 10_020n },
            { asset: WETH, amount: 7n, baseUnits: 7_000n },
        ]);
        expect(res.escrow.cancelInputs).toMatchObject({ feeIn: 7n, feeAssetId: WETH });
        expect(res.escrow.cancelInputs.feeCm).toBe(rec.submitted[0]!.deposit.feeCm);
    });

    it("zero fee: relayer null, never a zero Money, and the note names asset 0", async () => {
        const { res } = await run({}, { asset: USDC, feeAsset: WETH });
        expect(res.fees.relayer).toBeNull();
        expect(res.pulled).toEqual([{ asset: USDC, amount: 1_002n, baseUnits: 10_020n }]);
        expect(res.escrow.cancelInputs).toMatchObject({ feeIn: 0n, feeAssetId: 0n });
    });

    it("zero protocol rate: protocol null", async () => {
        const made = await makeCtx({ quotes: { "2": 7n } });
        // WETH at 0 bps.
        const resolve = made.ctx.assets.resolveVerified;
        (made.ctx.assets as { resolveVerified: unknown }).resolveVerified = async (r: unknown) => ({
            ...(await resolve(r as never)),
            depositBps: 0n,
        });
        const res = await executeDeposit(made.ctx, { asset: WETH, amount: circuitAmount(10n) });
        expect(res.fees.protocol).toBeNull();
    });

    it("native: no signature, the adapter's escrow, the coin's pull", async () => {
        const { res, rec, phases } = await run(
            { quotes: { "2": 7n } },
            { asset: WETH, native: true, amount: 10n },
        );
        expect(res.strategy).toBe("native");
        expect(res.native).toBe(true);
        expect(res.escrow).toMatchObject({ native: true, asset: WETH, depositId: 9n });
        expect(res.escrow.cancelInputs.payer).toBe(ADAPTER);
        expect(res.pulled).toEqual([{ asset: WETH, amount: 17n, baseUnits: 17_020n }]);
        expect(rec.signed).toHaveLength(0);
        expect(phases.map(([p]) => p)).toEqual([
            "preparing",
            "submitting",
            "broadcast",
            "confirmed",
        ]);
    });

    it("another recipient's note is not this wallet's own commitment", async () => {
        const other = await identity();
        const { res } = await run({}, { asset: USDC, recipient: other.address });
        expect(res.recipient).toBe(other.address.toLowerCase());
        expect(res.ownCommitments).toEqual([]);
        expect(res.nonZeroCommitments).toEqual(res.commitments);
    });

    it("refuses a passed deadline and an aborted signal before signing", async () => {
        const { ctx, rec } = await makeCtx({ quotes: { "1": 3n } });
        await expect(
            executeDeposit(ctx, { asset: USDC, amount: circuitAmount(1n), deadline: 1n }),
        ).rejects.toMatchObject({ code: "DEADLINE_PASSED" });
        const reason = new Error("stop");
        const controller = new AbortController();
        controller.abort(reason);
        await expect(
            executeDeposit(ctx, {
                asset: USDC,
                amount: circuitAmount(1n),
                signal: controller.signal,
            }),
        ).rejects.toBe(reason);
        expectNothingSent(rec);
    });
});

// A quote runs the deposit's own plan and strategy, so its figures are the ones signed.
describe("quoteDeposit", () => {
    it.each([
        ["same asset, witness", { quotes: { "1": 3n } }, { asset: USDC }],
        ["cross asset, witness", { quotes: { "2": 7n } }, { asset: USDC, feeAsset: WETH }],
        [
            "cross asset, allowance",
            {
                quotes: { "2": 7n },
                allowances: { [TOKEN_USDC]: 10_020n, [TOKEN_WETH]: 7_000n },
            },
            { asset: USDC, feeAsset: WETH },
        ],
        [
            "yield principal, plain fee over one token",
            { quotes: { "1": 3n } },
            { asset: YIELD_USDC, feeAsset: USDC },
        ],
        ["native", { quotes: { "2": 7n } }, { asset: WETH, native: true }],
    ] as const)("%s: pulls, fees and strategy equal the deposit's", async (_, opts, args) => {
        const quoted = await makeCtx(opts);
        const quote = await quoteDeposit(quoted.ctx, { amount: circuitAmount(1_000n), ...args });
        const executed = await makeCtx(opts);
        const res = await executeDeposit(executed.ctx, {
            amount: circuitAmount(1_000n),
            ...args,
        });

        expect(quote.strategy).toBe(res.strategy);
        expect(quote.fees).toEqual(res.fees);
        expect(quote.amount).toEqual(res.amount);
        // Per token in the quote, per asset in the result: the same total.
        const sum = (
            xs: readonly { baseUnits?: bigint; amount?: bigint }[],
            k: "baseUnits" | "amount",
        ) => xs.reduce((a, x) => a + (x[k] as bigint), 0n);
        expect(sum(quote.pulls, "amount")).toBe(sum(res.pulled, "baseUnits"));
        expect(quote.separateFee).toBe(res.pulled.length === 2);
        // The ceilings are what the witness path signs.
        const signed = executed.rec.signed[0];
        if (signed) {
            const ceilings = quote.pulls.reduce((a, p) => a + p.ceiling, 0n);
            expect(signed.maxTotal + (signed.maxFee ?? 0n)).toBe(ceilings);
        }
        if (res.strategy === "native")
            expect(executed.rec.native[0]!.value).toBe(quote.pulls[0]!.ceiling);
        expectNothingSent(quoted.rec);
        expect(Object.isFrozen(quote)).toBe(true);
    });

    it("reports balances, allowances and whether setup would help", async () => {
        const { ctx } = await makeCtx({
            quotes: { "2": 7n },
            allowances: { [TOKEN_USDC]: 10_020n },
            balances: { [TOKEN_USDC]: 50_000n, [TOKEN_WETH]: 6_999n },
        });
        const quote = await quoteDeposit(ctx, {
            asset: USDC,
            feeAsset: WETH,
            amount: circuitAmount(1_000n),
        });
        expect(quote.pulls.map((p) => [p.token, p.amount, p.balance, p.allowance?.covers])).toEqual(
            [
                [TOKEN_USDC, 10_020n, 50_000n, true],
                [TOKEN_WETH, 7_000n, 6_999n, false],
            ],
        );
        expect(quote).toMatchObject({
            strategy: "witness",
            principal: 10_020n,
            separateFee: true,
            feeSharesToken: false,
            allowanceSetupAvailable: true,
            sufficientBalance: false,
        });
    });

    it("counts a short ERC-20 approval against the allowance path, as the deposit does", async () => {
        const opts = {
            quotes: { "1": 3n },
            allowances: { [TOKEN_USDC]: 10_050n },
            erc20: { [TOKEN_USDC]: 10_049n },
        };
        const quote = await quoteDeposit((await makeCtx(opts)).ctx, {
            asset: USDC,
            amount: circuitAmount(1_000n),
        });
        expect(quote.pulls[0]!.allowance).toMatchObject({ erc20: 10_049n, covers: false });
        expect(quote.strategy).toBe("witness");
        const res = await executeDeposit((await makeCtx(opts)).ctx, {
            asset: USDC,
            amount: circuitAmount(1_000n),
        });
        expect(res.strategy).toBe("witness");

        const covered = { ...opts, erc20: { [TOKEN_USDC]: 10_050n } };
        const q2 = await quoteDeposit((await makeCtx(covered)).ctx, {
            asset: USDC,
            amount: circuitAmount(1_000n),
        });
        expect([q2.strategy, q2.allowanceSetupAvailable, q2.sufficientBalance]).toEqual([
            "allowance",
            false,
            undefined,
        ]);
    });

    it.each([
        [
            "a refused fee asset",
            { quotes: { "1": 3n } },
            { asset: USDC, feeAsset: YIELD_USDC },
            "INVALID_ARGUMENT",
        ],
        [
            "an unquoted fee asset",
            { quotes: { "1": 3n } },
            { asset: USDC, feeAsset: WETH },
            "FEE_ASSET_NOT_QUOTED",
        ],
        ["a zero amount", { quotes: { "1": 3n } }, { asset: USDC, amount: 0n }, "INVALID_ARGUMENT"],
    ] as const)("rejects %s as the deposit would", async (_, opts, args, code) => {
        const q = await makeCtx(opts);
        const d = await makeCtx(opts);
        const a = { amount: circuitAmount(1_000n), ...args } as never;
        await expect(quoteDeposit(q.ctx, a)).rejects.toMatchObject({ code });
        await expect(executeDeposit(d.ctx, a)).rejects.toMatchObject({ code });
        expectNothingSent(d.rec);
    });
});
