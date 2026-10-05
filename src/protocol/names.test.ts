import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors/config.js";
import { formatHandle, isNameLabel, NAME_TEXT_KEY, parseHandle } from "./names.js";

// The same lists as `contracts/test/names/LelantosNameRegistrar.t.sol`: a label the wallet accepts
// and the registrar refuses costs the user a refunded execution.
const GOOD = ["abc", "a-b", "a1b2c3", "000", "mehow", "abcdefghijklmnopqrstuvwxyz012345"];
const BAD = [
    "",
    "ab",
    "abcdefghijklmnopqrstuvwxyz0123456",
    "-ab",
    "ab-",
    "a--b",
    "ab--cd",
    "Abc",
    "a.b",
    "a b",
    "a_b",
    "abé",
];

describe("isNameLabel", () => {
    it.each(GOOD)("accepts %j", (label) => expect(isNameLabel(label)).toBe(true));
    it.each(BAD)("rejects %j", (label) => expect(isNameLabel(label)).toBe(false));
});

describe("parseHandle", () => {
    const PARENTS = ["lelantos.xyz", "lelantosid.eth"];

    it("takes a bare label, with or without the at sign, and folds its case", () => {
        expect(parseHandle("mehow")).toEqual({ label: "mehow", parent: undefined });
        expect(parseHandle("@mehow")).toEqual({ label: "mehow", parent: undefined });
        expect(parseHandle("  MeHow ")).toEqual({ label: "mehow", parent: undefined });
    });

    it("takes a label under a parent the deployment serves", () => {
        expect(parseHandle("mehow.lelantos.xyz", PARENTS)).toEqual({
            label: "mehow",
            parent: "lelantos.xyz",
        });
        expect(parseHandle("Mehow.LelantosID.eth", PARENTS)).toEqual({
            label: "mehow",
            parent: "lelantosid.eth",
        });
    });

    it("refuses every other parent, however close", () => {
        for (const name of [
            "mehow.lelantos.eth",
            "mehow.lelantos.xyz.evil.eth",
            "mehow.xyz",
            "a.mehow.lelantos.xyz",
            "mehow.",
        ]) {
            expect(() => parseHandle(name, PARENTS), name).toThrow(
                expect.objectContaining({ argument: "name", details: { reason: "parent" } }),
            );
        }
        // With no parents configured, only a bare label parses.
        expect(() => parseHandle("mehow.lelantos.xyz")).toThrow(InvalidArgumentError);
    });

    it("refuses a malformed label", () => {
        for (const name of ["ab", "a--b", "-mehow", "mehow-", "me how", "", "@", 7, null]) {
            expect(() => parseHandle(name, PARENTS), String(name)).toThrow(InvalidArgumentError);
        }
        expect(() => parseHandle("a--b.lelantos.xyz", PARENTS)).toThrow(
            expect.objectContaining({ details: { reason: "label" } }),
        );
    });
});

describe("formatHandle", () => {
    it("joins a label and a parent", () => {
        expect(formatHandle("mehow", "lelantos.xyz")).toBe("mehow.lelantos.xyz");
    });

    it("names the text key under our own DNS namespace", () => {
        expect(NAME_TEXT_KEY).toBe("xyz.lelantos.address");
    });
});
