import { describe, expect, it } from "vitest";
import { assetId, circuitAmount } from "../core/brand.js";
import { NoEvmAccountError } from "../errors/chain.js";
import { WALLET_ERROR_CODES, type WalletErrorCode } from "../errors/codes.js";
import { WalletConfigError } from "../errors/config.js";
import { InsufficientCoverError } from "../errors/funds.js";
import { isWalletError, type WalletErrorOf } from "../errors/guard.js";
import { NetworkError } from "../errors/network.js";
import { WorkerRpcError } from "../errors/worker.js";
import { testWallet } from "../test-utils/wallet.js";

const cover = new InsufficientCoverError({
    target: circuitAmount(10n),
    asset: assetId(1n),
    consolidate: [],
    consolidateSum: circuitAmount(4n),
});

describe("isWalletError", () => {
    it("accepts SDK errors and rejects everything else", () => {
        expect(isWalletError(cover)).toBe(true);
        expect(isWalletError(new WalletConfigError("nope"))).toBe(true);
        expect(isWalletError(new Error("plain"))).toBe(false);
        expect(isWalletError({ code: "INSUFFICIENT_COVER" })).toBe(false);
        expect(isWalletError(undefined)).toBe(false);
    });

    it("filters on a specific code", () => {
        expect(isWalletError(cover, "INSUFFICIENT_COVER")).toBe(true);
        expect(isWalletError(cover, "WALLET_CONFIG")).toBe(false);
    });

    it("ignores unknown codes on Error-shaped objects", () => {
        const impostor = Object.assign(new Error("x"), { code: "ENOENT" });
        expect(isWalletError(impostor)).toBe(false);
    });

    it("narrows to the variant's context fields", () => {
        const err: unknown = cover;
        if (!isWalletError(err, "INSUFFICIENT_COVER")) throw new Error("guard failed");
        // Type-level assertion: these only compile after narrowing.
        expect(err.consolidateSum).toBe(4n);
        expect(err.target).toBe(10n);
    });
});

describe("error codes", () => {
    it("every class reports a code from the published list", () => {
        const errors = [
            cover,
            new WalletConfigError("x"),
            new NetworkError("FMD_TIMEOUT", "http://x", "timed out"),
        ];
        for (const e of errors) expect(WALLET_ERROR_CODES).toContain(e.code);
    });

    it("keeps the URL and status on network failures", () => {
        const e = new NetworkError("RELAYER_FAILED", "http://r", "boom", { status: 502 });
        expect(e.url).toBe("http://r");
        expect(e.status).toBe(502);
        expect(e.message).toContain("http://r");
    });
});

// `WalletErrorOf` is an `Extract` over `AnyWalletError`, which matches a member only when its
// `code` is assignable to the requested literal. A class covering several codes (`NetworkError`,
// `WorkerRpcError`) declares a union-typed `code`, which is not assignable to a single literal;
// listed once in `AnyWalletError`, each of its codes would resolve to `never` and narrowing would
// drop `url`, `status`, `body` and `method`. `AnyWalletError` therefore lists those classes once
// per code. The check below ensures every code narrows to a non-`never` type.
type UnnarrowableCode = {
    [K in WalletErrorCode]: [WalletErrorOf<K>] extends [never] ? K : never;
}[WalletErrorCode];

// Fails to compile, naming the offending codes, if any is `never`. Asserted in this direction
// because `never` is assignable to every type, so a plain assignment would pass when broken.
type Assert<T extends true> = T;
type _EveryCodeNarrows = Assert<[UnnarrowableCode] extends [never] ? true : false>;

describe("WalletErrorOf", () => {
    it("narrows multi-code classes to their context fields", () => {
        const net: unknown = new NetworkError("RELAYER_TIMEOUT", "http://r", "slow", {
            status: 504,
            body: "gateway timeout",
        });
        if (!isWalletError(net, "RELAYER_TIMEOUT")) throw new Error("guard failed");
        // Type-level assertion: these compile only if the code does not narrow
        // to `never`.
        expect(net.url).toBe("http://r");
        expect(net.status).toBe(504);
        expect(net.body).toBe("gateway timeout");

        const rpc: unknown = new WorkerRpcError("WORKER_TIMEOUT", "no answer", { method: "prove" });
        if (!isWalletError(rpc, "WORKER_TIMEOUT")) throw new Error("guard failed");
        expect(rpc.method).toBe("prove");
    });

    it("still rejects a sibling code from the same class", () => {
        const net = new NetworkError("FMD_FAILED", "http://f", "boom");
        expect(isWalletError(net, "FMD_FAILED")).toBe(true);
        expect(isWalletError(net, "FMD_TIMEOUT")).toBe(false);
        expect(isWalletError(net, "RELAYER_FAILED")).toBe(false);
    });
});

describe("NoEvmAccountError", () => {
    it("explains that cancelling, not depositing, needs a signing account", async () => {
        const { wallet } = await testWallet();

        const err = await wallet.cancelDeposit({ depositId: 1n }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NoEvmAccountError);
        expect(err).toMatchObject({ code: "NO_EVM_ACCOUNT", operation: "cancelDeposit" });
        // Neutral: names the operation, never "add funds", which misdirects a user getting funds back.
        expect((err as Error).message).toMatch(/cancelDeposit/);
        expect((err as Error).message).not.toMatch(/add funds/);
    });

    it("names the deposit for a deposit", () => {
        const err = new NoEvmAccountError();
        expect(err.operation).toBe("deposit");
        expect(err.message).toMatch(/^deposit needs an EVM account/);
        expect(err.retryable).toBe(false);
    });
});
