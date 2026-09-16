// The error model's own mechanics: retryable per class, the boundary helper,
// the invariant helper, and recognising a wallet's "user rejected".

import { describe, expect, it } from "vitest";
import { assertInvariant, InternalError } from "./base.js";
import { boundary } from "./boundary.js";
import { asUserRejection, ChainRpcError, TxMiningError, UserRejectedError } from "./chain.js";
import { InvalidArgumentError } from "./config.js";
import { isWalletError } from "./guard.js";
import { NetworkError, TreeOutOfSyncError } from "./network.js";
import { WorkerRpcError } from "./worker.js";

describe("retryable", () => {
    it.each([
        [new NetworkError("RELAYER_TIMEOUT", "u", "slow"), true],
        [new NetworkError("FMD_FAILED", "u", "no response"), true],
        [new NetworkError("RELAYER_FAILED", "u", "HTTP 503", { status: 503 }), true],
        [new NetworkError("RELAYER_FAILED", "u", "HTTP 429", { status: 429 }), true],
        [new NetworkError("RELAYER_FAILED", "u", "HTTP 400", { status: 400 }), false],
        [new ChainRpcError("fetchAsset"), true],
        [new ChainRpcError("fetchAsset", { retryable: false }), false],
        [new TxMiningError("no receipt"), true],
        [new TreeOutOfSyncError({ localRoot: 1n, mirrorRoot: 2n }), true],
        [new WorkerRpcError("WORKER_TIMEOUT", "slow"), true],
        [new WorkerRpcError("WORKER_CRASHED", "gone"), false],
        [new InvalidArgumentError("bad", { argument: "x" }), false],
        [new InternalError("bug"), false],
    ])("%s", (err, retryable) => {
        expect(err.retryable).toBe(retryable);
    });
});

describe("TreeOutOfSyncError", () => {
    it("carries both roots as fields, not in the message", () => {
        const err = new TreeOutOfSyncError({ localRoot: 123n, mirrorRoot: 456n });
        expect(err).toMatchObject({
            code: "TREE_OUT_OF_SYNC",
            localRoot: "123",
            mirrorRoot: "456",
        });
        expect(err.message).not.toMatch(/123|456/);
    });
});

describe("assertInvariant", () => {
    it("throws InternalError with details when the condition fails", () => {
        expect(() => assertInvariant(false, "broken", { slot: 2 })).toThrow(
            expect.objectContaining({ code: "INTERNAL", details: { slot: 2 } }),
        );
        expect(() => assertInvariant(1, "fine")).not.toThrow();
    });
});

describe("boundary", () => {
    it("passes a WalletError through and records the operation once", async () => {
        const inner = new InvalidArgumentError("bad", { argument: "amount" });
        inner.withContext({ op: "inner" });
        await expect(boundary("outer", async () => Promise.reject(inner))).rejects.toBe(inner);
        expect(inner.context.op).toBe("inner");

        const fresh = new InvalidArgumentError("bad", { argument: "amount" });
        await expect(boundary("transfer", async () => Promise.reject(fresh))).rejects.toBe(fresh);
        expect(fresh.context.op).toBe("transfer");
    });

    it("wraps anything else as INTERNAL with the original as cause", async () => {
        const boom = new TypeError("x is undefined");
        const err = await boundary("sync", async () => Promise.reject(boom)).catch((e) => e);
        expect(isWalletError(err, "INTERNAL")).toBe(true);
        expect(err.cause).toBe(boom);
        expect(err.context.op).toBe("sync");

        const thrownString = await boundary("sync", () => {
            throw "nope";
        }).catch((e) => e);
        expect(isWalletError(thrownString, "INTERNAL")).toBe(true);
    });

    it("lets the caller's own abort reason through unchanged", async () => {
        const ctrl = new AbortController();
        const reason = new Error("stop");
        ctrl.abort(reason);
        await expect(
            boundary("sync", async () => Promise.reject(reason), ctrl.signal),
        ).rejects.toBe(reason);
        // Another error while aborted is still wrapped.
        const other = new Error("unrelated");
        await expect(
            boundary("sync", async () => Promise.reject(other), ctrl.signal),
        ).rejects.toMatchObject({ code: "INTERNAL" });
    });
});

describe("user rejection", () => {
    it.each([
        ["an EIP-1193 4001 object", { code: 4001, message: "User rejected the request." }],
        ["an Error with code 4001", Object.assign(new Error("denied"), { code: 4001 })],
        [
            "ethers' ACTION_REJECTED",
            Object.assign(new Error("user rejected"), { code: "ACTION_REJECTED" }),
        ],
        [
            "viem's UserRejectedRequestError, wrapped",
            new Error("tx failed", {
                cause: Object.assign(new Error("User rejected"), {
                    name: "UserRejectedRequestError",
                }),
            }),
        ],
    ])("recognises %s", (_name, err) => {
        const mapped = asUserRejection(err, "send-tx");
        expect(mapped).toBeInstanceOf(UserRejectedError);
        expect(mapped).toMatchObject({
            code: "USER_REJECTED",
            action: "send-tx",
            retryable: false,
        });
    });

    it("leaves other failures alone", () => {
        const err = Object.assign(new Error("insufficient funds"), { code: -32000 });
        expect(asUserRejection(err, "send-tx")).toBe(err);
    });

    it("re-labels the action", () => {
        const signed = new UserRejectedError("sign-permit");
        expect(asUserRejection(signed, "derive-key")).toMatchObject({ action: "derive-key" });
        expect(asUserRejection(signed, "sign-permit")).toBe(signed);
    });
});
