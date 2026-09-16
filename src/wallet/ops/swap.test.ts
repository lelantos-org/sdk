import { describe, expect, it } from "vitest";
import type { ChainAdapter, ChainReader } from "../../chain/port.js";
import { evmAddress } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { DeadlinePassedError } from "../../errors/spend.js";
import { applyFee, depositTotal } from "../../protocol/fees.js";
import { sizeBNote, sizeRefundNote } from "../../protocol/swap-sizing.js";
import { SWAP_DEFAULT_DEADLINE_SECS } from "../constants.js";
import { resolveSwapDeadline } from "../tx/deadline.js";
import { resolveRefundAddress } from "./swap-escrow.js";

// `SwapWrapper` accepts the deposit leg only when the pool's Permit2 pull is at least `minOut`
// (`MaspPullBelowMinOut`) and at most the venue's actual output (`MaspPullExceedsActualOut`). The
// closed form satisfies only the upper bound: it floor-divides, so the pull can be one unit short
// and the swap reverts on-chain after proving.

/**
 * Amount `MASP.deposit*` pulls for a B note of `v`: principal, the pool's floored fee, and the
 * flush fee note, priced by the SDK's one model of `MASP._quoteShield` (tested in
 * `protocol/fees.test.ts`) rather than a copy of it.
 */
const pullFor = (v: bigint, scale: bigint, feeBps: bigint, relayerFee = 0n): bigint =>
    depositTotal({ publicIn: v, feeIn: relayerFee, depositBps: feeBps, scale });

const FEE_BPS = 500n; // 5%, as deployed in the e2e stack

// `SwapWrapper` bounds the refund pull by what leg 1 delivered, so the refund note must be the
// largest value that fits under `received`.
describe("sizeRefundNote", () => {
    it("always fits what leg 1 delivered, and is the largest that does", () => {
        for (const scale of [1n, 10n, 10_000_000_000n]) {
            for (const relayerFee of [0n, 3n]) {
                for (let units = 1n; units <= 400n; units += 1n) {
                    const received = units * scale - applyFee(units * scale, 25n);
                    const v = sizeRefundNote(received, scale, FEE_BPS, relayerFee);
                    const at = `received=${received} scale=${scale} relayerFee=${relayerFee}`;
                    if (v > 0n) {
                        expect(
                            pullFor(v, scale, FEE_BPS, relayerFee),
                            `fits: ${at}`,
                        ).toBeLessThanOrEqual(received);
                    }
                    expect(
                        pullFor(v + 1n, scale, FEE_BPS, relayerFee),
                        `largest: ${at}`,
                    ).toBeGreaterThan(received);
                }
            }
        }
    });

    it("returns zero when not even one unit fits", () => {
        expect(sizeRefundNote(9n, 10n, FEE_BPS)).toBe(0n);
        expect(sizeRefundNote(100n, 1n, FEE_BPS, 100n)).toBe(0n);
    });
});

describe("sizeBNote", () => {
    /// 8-decimal asset (scale 1) at 5% fee: the closed form yields 89, a pull of 93 against a
    /// minOut of 94.
    it("covers minOut where the closed form falls one short", () => {
        const minOut = 94n;
        const closedForm = (minOut * 10_000n) / (1n * (10_000n + FEE_BPS));
        expect(pullFor(closedForm, 1n, FEE_BPS)).toBe(93n); // closed form falls short
        expect(closedForm).toBe(89n);

        const v = sizeBNote(minOut, 1n, FEE_BPS);
        expect(v).toBe(90n);
        expect(pullFor(v, 1n, FEE_BPS)).toBe(94n);
    });

    /// Two-sided property over the range where fee flooring matters.
    it("always covers minOut, and never by more than necessary", () => {
        for (const scale of [1n, 10n, 10_000_000_000n]) {
            for (let minOut = 1n; minOut <= 400n; minOut += 1n) {
                const v = sizeBNote(minOut, scale, FEE_BPS);
                expect(
                    pullFor(v, scale, FEE_BPS),
                    `pull must cover minOut=${minOut} scale=${scale}`,
                ).toBeGreaterThanOrEqual(minOut);
                // Minimal: one step down must not cover it. Minimality keeps the pull under
                // `actualOut`.
                if (v > 0n) {
                    expect(
                        pullFor(v - 1n, scale, FEE_BPS),
                        `v=${v} is not minimal for minOut=${minOut} scale=${scale}`,
                    ).toBeLessThan(minOut);
                }
            }
        }
    });

    it("is exact when the fee divides cleanly", () => {
        // 100 principal + 5 fee = 105, hit exactly.
        expect(sizeBNote(105n, 1n, FEE_BPS)).toBe(100n);
        expect(pullFor(100n, 1n, FEE_BPS)).toBe(105n);
    });

    it("handles a zero fee", () => {
        expect(sizeBNote(250n, 1n, 0n)).toBe(250n);
        expect(pullFor(250n, 1n, 0n)).toBe(250n);
    });

    /// A minOut below one scaled unit cannot be represented; the caller raises
    /// `InvalidArgumentError` instead of escrowing nothing.
    it("returns zero when minOut is below one scaled unit", () => {
        expect(sizeBNote(0n, 10n, FEE_BPS)).toBe(0n);
    });

    /// The swap's relayer fee pays for relaying the swap transaction, not for flushing the B-note
    /// deposit. The flush fee is paid from the same Permit2 pull, reducing the B-note.
    it("funds the relayer fee out of the pull, shrinking the note", () => {
        const minOut = 105n;
        const withoutFee = sizeBNote(minOut, 1n, FEE_BPS);
        const withFee = sizeBNote(minOut, 1n, FEE_BPS, 5n);

        expect(withFee).toBeLessThan(withoutFee);
        // Inside the wrapper's window: the pull covers `minOut`
        expect(pullFor(withFee, 1n, FEE_BPS, 5n)).toBeGreaterThanOrEqual(minOut);
        // and is minimal, which keeps it under `actualOut`.
        expect(pullFor(withFee - 1n, 1n, FEE_BPS, 5n)).toBeLessThan(minOut);
    });

    /// Same two-sided property as above, with a fee in the pull.
    it("stays inside the wrapper's window at every relayer fee", () => {
        for (const relayerFee of [0n, 1n, 7n, 50n]) {
            for (const scale of [1n, 10n, 10_000_000_000n]) {
                for (let minOut = 1n; minOut <= 200n; minOut += 1n) {
                    const v = sizeBNote(minOut, scale, FEE_BPS, relayerFee);
                    const label = `minOut=${minOut} scale=${scale} fee=${relayerFee}`;
                    expect(pullFor(v, scale, FEE_BPS, relayerFee), label).toBeGreaterThanOrEqual(
                        minOut,
                    );
                    if (v > 0n) {
                        expect(
                            pullFor(v - 1n, scale, FEE_BPS, relayerFee),
                            `not minimal: ${label}`,
                        ).toBeLessThan(minOut);
                    }
                }
            }
        }
    });

    /// A fee that covers `minOut` alone leaves nothing to deposit; `executeSwap` rejects the
    /// resulting zero B-note.
    it("returns zero when the fee alone covers minOut", () => {
        expect(sizeBNote(10n, 1n, FEE_BPS, 50n)).toBe(0n);
    });
});

// A yield output (or refund) note is a yield deposit: the pool prices its pull in units at
// `gross / supply`, so sizing it at `scale` alone lands the pull off the wrapper's window by the
// index.
describe("yield-asset note sizing", () => {
    const yieldPull = (
        v: bigint,
        scale: bigint,
        rate: { gross: bigint; supply: bigint },
        relayerFee = 0n,
    ) =>
        depositTotal({
            publicIn: v,
            feeIn: relayerFee,
            depositBps: FEE_BPS,
            scale,
            yieldEnabled: true,
            rate,
        });

    it("sizes a B-note whose yield pull covers minOut, minimally, at every rate", () => {
        for (const rate of [
            { gross: 1n, supply: 1n },
            { gross: 105n, supply: 100n },
            { gross: 3n, supply: 1n },
            { gross: 999n, supply: 1_000n },
        ]) {
            for (const scale of [1n, 10n, 1_000n]) {
                for (const relayerFee of [0n, 4n]) {
                    for (let minOut = 1n; minOut <= 3_000n; minOut += 7n) {
                        const v = sizeBNote(minOut, scale, FEE_BPS, relayerFee, {
                            yieldEnabled: true,
                            rate,
                        });
                        const at = `minOut=${minOut} scale=${scale} rate=${rate.gross}/${rate.supply} fee=${relayerFee}`;
                        expect(yieldPull(v, scale, rate, relayerFee), at).toBeGreaterThanOrEqual(
                            minOut,
                        );
                        if (v > 0n) {
                            expect(
                                yieldPull(v - 1n, scale, rate, relayerFee),
                                `not minimal: ${at}`,
                            ).toBeLessThan(minOut);
                        }
                    }
                }
            }
        }
    });

    it("sizes the largest yield refund note that fits what leg 1 delivered", () => {
        const rate = { gross: 21n, supply: 10n };
        for (const scale of [1n, 10n]) {
            for (const relayerFee of [0n, 3n]) {
                for (let received = 1n; received <= 2_000n; received += 13n) {
                    const v = sizeRefundNote(received, scale, FEE_BPS, relayerFee, {
                        yieldEnabled: true,
                        rate,
                    });
                    const at = `received=${received} scale=${scale} fee=${relayerFee}`;
                    if (v > 0n) {
                        expect(yieldPull(v, scale, rate, relayerFee), at).toBeLessThanOrEqual(
                            received,
                        );
                    }
                    expect(
                        yieldPull(v + 1n, scale, rate, relayerFee),
                        `largest: ${at}`,
                    ).toBeGreaterThan(received);
                }
            }
        }
    });

    it("differs from plain sizing once the index has grown", () => {
        const rate = { gross: 2n, supply: 1n };
        const plain = sizeBNote(10_000n, 1n, FEE_BPS);
        const yielding = sizeBNote(10_000n, 1n, FEE_BPS, 0n, { yieldEnabled: true, rate });
        // Each unit is worth two tokens, so half as many units cover the floor.
        expect(yielding * 2n).toBeGreaterThanOrEqual(plain - 2n);
        expect(yielding * 2n).toBeLessThanOrEqual(plain + 2n);
    });
});

describe("resolveRefundAddress", () => {
    const WRAPPER = evmAddress(`0x${"ab".repeat(20)}`);
    const BUNDLER = `0x${"11".repeat(20)}`;
    const EOA = `0x${"33".repeat(20)}`;
    const EXPLICIT = `0x${"44".repeat(20)}`;
    const ADVERTISED = `0x${"55".repeat(20)}`;

    // Only the members `supportsSigning` probes.
    const reader = {} as ChainReader;
    const signer = {
        payerAddress: async () => EOA,
        signPermit2: async () => {
            throw new Error("unused");
        },
    } as unknown as ChainAdapter;

    const ctx = (chain: ChainReader, advertised?: string) => ({
        cfg: { chain, relayerAddress: BUNDLER },
        relayerInfo: { tokens: undefined, refundAddress: async () => advertised },
    });

    it("prefers an explicit refundAddress over every default", async () => {
        await expect(
            resolveRefundAddress(ctx(signer, ADVERTISED), EXPLICIT, WRAPPER),
        ).resolves.toBe(EXPLICIT);
    });

    it("defaults to the wallet's own EVM account", async () => {
        await expect(
            resolveRefundAddress(ctx(signer, ADVERTISED), undefined, WRAPPER),
        ).resolves.toBe(EOA);
    });

    it("falls back to the relayer-advertised refund address without an EVM account", async () => {
        await expect(
            resolveRefundAddress(ctx(reader, ADVERTISED), undefined, WRAPPER),
        ).resolves.toBe(ADVERTISED);
    });

    it("throws when no refund address is available", async () => {
        await expect(resolveRefundAddress(ctx(reader), undefined, WRAPPER)).rejects.toBeInstanceOf(
            InvalidArgumentError,
        );
    });

    it("refuses zero, the wrapper and the Bundler, in any case, from any source", async () => {
        const zero = `0x${"00".repeat(20)}`;
        for (const bad of [zero, WRAPPER, WRAPPER.toUpperCase().replace("0X", "0x"), BUNDLER]) {
            await expect(resolveRefundAddress(ctx(reader), bad, WRAPPER)).rejects.toBeInstanceOf(
                InvalidArgumentError,
            );
            await expect(
                resolveRefundAddress(ctx(reader, bad), undefined, WRAPPER),
            ).rejects.toBeInstanceOf(InvalidArgumentError);
        }
    });
});

// The deadline is covered by the withdraw proof's intent hash, so the wallet always sets it; a
// relayer default would not match the proof.
describe("resolveSwapDeadline", () => {
    const NOW = 1_800_000_000n;

    it("defaults to now plus the swap window", () => {
        expect(resolveSwapDeadline(undefined, NOW)).toBe(NOW + BigInt(SWAP_DEFAULT_DEADLINE_SECS));
    });

    it("keeps an explicit deadline exactly", () => {
        expect(resolveSwapDeadline(NOW + 42n, NOW)).toBe(NOW + 42n);
    });

    it("refuses a deadline that has already passed", () => {
        for (const past of [NOW, NOW - 1n]) {
            expect(() => resolveSwapDeadline(past, NOW)).toThrow(DeadlinePassedError);
        }
    });
});
