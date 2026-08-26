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
        // `btoa` is Latin-1 only and throws on these directly, so the UTF-8
        // step is load-bearing — a server description in any non-Latin script
        // would otherwise break every payment to it.
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
        expect(await readPaymentRequired(res, "https://x/y")).toEqual(offer);
    });

    it("finds the header whatever its casing on the wire", async () => {
        const res = new Response("", {
            status: 402,
            headers: { "payment-required": encodeBase64Json(offer) },
        });
        expect(await readPaymentRequired(res, "https://x/y")).toEqual(offer);
    });

    it("falls back to a body-carried document", async () => {
        const res = new Response(JSON.stringify(offer), {
            status: 402,
            headers: { "content-type": "application/json" },
        });
        expect(await readPaymentRequired(res, "https://x/y")).toEqual(offer);
    });

    it("falls back to the body when the header decodes but has no accepts[]", async () => {
        const res = new Response(JSON.stringify(offer), {
            status: 402,
            headers: {
                [HEADER_PAYMENT_REQUIRED]: encodeBase64Json({ x402Version: 2 }),
                "content-type": "application/json",
            },
        });
        expect(await readPaymentRequired(res, "https://x/y")).toEqual(offer);
    });

    it("leaves the caller's response body readable", async () => {
        const res = new Response(JSON.stringify(offer), { status: 402 });
        await readPaymentRequired(res, "https://x/y");
        expect(res.bodyUsed).toBe(false);
    });

    it("rejects a 402 carrying nothing usable", async () => {
        const res = new Response("go away", { status: 402 });
        await expect(readPaymentRequired(res, "https://x/y")).rejects.toThrow(
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
