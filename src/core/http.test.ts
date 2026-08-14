import { describe, expect, it } from "vitest";
import { redactUrl } from "./http.js";

describe("redactUrl", () => {
    it("redacts the subscription bearer token in a query string", () => {
        expect(redactUrl("https://fmd.example/v1/matches?token=deadbeef&limit=10")).toBe(
            "https://fmd.example/v1/matches?token=REDACTED&limit=10",
        );
    });

    it("redacts the bearer token in the DELETE path segment", () => {
        expect(redactUrl("https://fmd.example/v1/subscriptions/deadbeef")).toBe(
            "https://fmd.example/v1/subscriptions/REDACTED",
        );
    });

    it("leaves the collection path alone", () => {
        expect(redactUrl("https://fmd.example/v1/subscriptions")).toBe(
            "https://fmd.example/v1/subscriptions",
        );
    });

    it("matches secret param names case-insensitively", () => {
        expect(redactUrl("https://r.example/scan?fmdSecret=abc")).toBe(
            "https://r.example/scan?fmdSecret=REDACTED",
        );
    });

    it("keeps ordinary params readable", () => {
        const u = "https://fmd.example/v1/notes?chainId=31337&limit=64&after=8";
        expect(redactUrl(u)).toBe(u);
    });

    it("refuses to pass through a URL it cannot parse", () => {
        expect(redactUrl("not a url?token=deadbeef")).toBe("<unparseable url>");
    });
});
