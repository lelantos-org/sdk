import { describe, expect, it } from "vitest";
import {
    decodeBase64Json,
    encodeBase64Json,
    readPaymentRequired,
    readSettlement,
} from "./codec.js";
import { HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE } from "./types.js";

describe("base64 JSON", () => {
    it("round-trips", () => {
        const value = { x402Version: 2, accepts: [{ scheme: "exact" }] };
        expect(decodeBase64Json(encodeBase64Json(value), "u", "h")).toEqual(value);
    });

    it("survives non-ASCII text", () => {
        // `btoa` is Latin-1 only and throws on these directly; the UTF-8 step
        // is required for descriptions in non-Latin scripts.
        const value = { description: "プレミアムデータ — 高速 · émoji 🚀" };
        expect(decodeBase64Json(encodeBase64Json(value), "u", "h")).toEqual(value);
    });

    it("tolerates surrounding whitespace, which proxies add", () => {
        expect(decodeBase64Json(`  ${encodeBase64Json({ a: 1 })}\n`, "u", "h")).toEqual({ a: 1 });
    });

    it("reports a bad header as unsupported requirements, not a crash", () => {
        expect(() =>
            decodeBase64Json("!!!not base64!!!", "https://x/y", "PAYMENT-REQUIRED"),
        ).toThrow(/not valid base64 JSON/);
    });
});

describe("readPaymentRequired", () => {
    const offer = { x402Version: 2, accepts: [{ scheme: "exact", network: "shielded:1" }] };

    it("reads the v2 header", async () => {
        const res = new Response("", {
            status: 402,
            headers: { [HEADER_PAYMENT_REQUIRED]: encodeBase64Json(offer) },
        });
        expect(readPaymentRequired(res, "https://x/y")).toEqual(offer);
    });

    it("finds the header whatever its casing on the wire", async () => {
        const res = new Response("", {
            status: 402,
            headers: { "payment-required": encodeBase64Json(offer) },
        });
        expect(readPaymentRequired(res, "https://x/y")).toEqual(offer);
    });

    it("ignores a body-carried document", async () => {
        const res = new Response(JSON.stringify(offer), {
            status: 402,
            headers: { "content-type": "application/json" },
        });
        expect(() => readPaymentRequired(res, "https://x/y")).toThrow(
            /without a usable PAYMENT-REQUIRED header/,
        );
    });

    it("rejects another protocol version", async () => {
        const res = new Response("", {
            status: 402,
            headers: { [HEADER_PAYMENT_REQUIRED]: encodeBase64Json({ ...offer, x402Version: 1 }) },
        });
        expect(() => readPaymentRequired(res, "https://x/y")).toThrow(/protocol version 1/);
    });

    it("rejects a 402 carrying nothing usable", async () => {
        const res = new Response("go away", { status: 402 });
        expect(() => readPaymentRequired(res, "https://x/y")).toThrow(
            /without a usable PAYMENT-REQUIRED header/,
        );
    });
});

describe("readSettlement", () => {
    it("reads a receipt", () => {
        const settlement = { success: true, transaction: "0x1", network: "shielded:1" };
        const res = new Response("", {
            headers: { [HEADER_PAYMENT_RESPONSE]: encodeBase64Json(settlement) },
        });
        expect(readSettlement(res)).toEqual(settlement);
    });

    it("returns undefined when absent", () => {
        expect(readSettlement(new Response(""))).toBeUndefined();
    });

    it("swallows a malformed receipt — the request was already paid for", () => {
        const res = new Response("", { headers: { [HEADER_PAYMENT_RESPONSE]: "garbage" } });
        expect(readSettlement(res)).toBeUndefined();
    });
});
