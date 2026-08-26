import { describe, expect, it } from "vitest";
import {
    InsufficientCoverError,
    isWalletError,
    NetworkError,
    WALLET_ERROR_CODES,
    WalletConfigError,
    type WalletErrorCode,
    type WalletErrorOf,
    WorkerRpcError,
} from "../core/errors.js";

const cover = new InsufficientCoverError({
    target: 10n,
    asset: 1n,
    consolidate: [],
    consolidateSum: 4n,
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

// `WalletErrorOf` is an `Extract` over `AnyWalletError`, which matches a member
// only when its `code` is assignable to the literal asked for. A class covering
// several codes — `NetworkError`, `WorkerRpcError` — declares a union-typed
// `code`, which never is, so listing it once in `AnyWalletError` silently
// resolved every one of its codes to `never`: the guard kept returning `true`
// while narrowing away `url`, `status`, `body` and `method`. `AnyWalletError`
// expands those two classes one code per member to stop it. The gate below is
// what keeps a code from regressing to `never` when the next multi-code class
// is added.
type UnnarrowableCode = {
    [K in WalletErrorCode]: [WalletErrorOf<K>] extends [never] ? K : never;
}[WalletErrorCode];

// Fails to compile naming the offending codes if any is `never`. Asserted this
// way round because `never` is assignable to every type, so a plain assignment
// would pass in exactly the broken case.
type Assert<T extends true> = T;
type _EveryCodeNarrows = Assert<[UnnarrowableCode] extends [never] ? true : false>;

describe("WalletErrorOf", () => {
    it("narrows multi-code classes to their context fields", () => {
        const net: unknown = new NetworkError("RELAYER_TIMEOUT", "http://r", "slow", {
            status: 504,
            body: "gateway timeout",
        });
        if (!isWalletError(net, "RELAYER_TIMEOUT")) throw new Error("guard failed");
        // Type-level assertion: these only compile if the code did not narrow
        // to `never`. They were all `Property … does not exist on type 'never'`.
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
