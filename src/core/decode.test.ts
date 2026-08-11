import { describe, expect, it } from "vitest";
import {
    arr,
    arrN,
    bigintFrom,
    bool,
    hexBytes,
    hexInt,
    int,
    mapArr,
    obj,
    opt,
    str,
    tuple2,
} from "./decode.js";
import { isWalletError } from "./errors.js";

function pathOf(fn: () => unknown): string | undefined {
    try {
        fn();
    } catch (e) {
        return (e as { path?: string }).path;
    }
    return undefined;
}

describe("obj / arr / arrN", () => {
    it("accepts a plain object and rejects arrays and null", () => {
        expect(obj({ a: 1 }, "$")).toEqual({ a: 1 });
        expect(() => obj([], "$")).toThrow(/expected an object/);
        expect(() => obj(null, "$")).toThrow(/got null/);
    });

    it("enforces a fixed length", () => {
        expect(arrN([1, 2], "$", 2)).toEqual([1, 2]);
        expect(() => arrN([1], "$", 2)).toThrow(/length 2/);
        expect(() => arr("x", "$")).toThrow(/expected an array/);
    });
});

describe("int", () => {
    it("rejects floats, NaN, and anything past 2^53", () => {
        expect(int(42, "$")).toBe(42);
        expect(() => int(1.5, "$")).toThrow(/safe integer/);
        expect(() => int(Number.NaN, "$")).toThrow(/safe integer/);
        expect(() => int(2 ** 53, "$")).toThrow(/safe integer/);
        expect(() => int("3", "$")).toThrow(/safe integer/);
    });
});

describe("bigintFrom", () => {
    it("accepts decimal strings, 0x-hex, and JSON numbers", () => {
        expect(bigintFrom("123", "$")).toBe(123n);
        expect(bigintFrom("-7", "$")).toBe(-7n);
        expect(bigintFrom("0x2a", "$")).toBe(42n);
        expect(bigintFrom("0X2A", "$")).toBe(42n);
        expect(bigintFrom(9, "$")).toBe(9n);
        expect(bigintFrom(5n, "$")).toBe(5n);
    });

    it("rejects the shapes BigInt() would otherwise accept or crash on", () => {
        // BigInt("") is 0n and BigInt(" 1 ") is 1n — both silent surprises.
        expect(() => bigintFrom("", "$")).toThrow(/decimal or 0x-hex/);
        expect(() => bigintFrom(" 1 ", "$")).toThrow(/decimal or 0x-hex/);
        expect(() => bigintFrom("12abc", "$")).toThrow(/decimal or 0x-hex/);
        expect(() => bigintFrom("0x", "$")).toThrow(/decimal or 0x-hex/);
        expect(() => bigintFrom(null, "$")).toThrow(/got null/);
        expect(() => bigintFrom(1.5, "$")).toThrow(/safe integer/);
    });
});

describe("hexInt", () => {
    it("accepts prefixed and bare hex", () => {
        expect(hexInt("0x2a", "$")).toBe(42n);
        expect(hexInt("0X2A", "$")).toBe(42n);
        expect(hexInt("2a", "$")).toBe(42n);
        expect(hexInt("dead", "$")).toBe(0xdeadn);
    });

    it("reads an all-digit bare-hex value as hex, not decimal", () => {
        // The reason this exists rather than reusing `bigintFrom`: the server
        // sends `commitmentHex` and `cmHex` without a `0x`, and a value made
        // only of decimal digits is also a valid decimal string. `bigintFrom`
        // would decode 4660 here and nothing downstream would notice.
        expect(hexInt("1234", "$")).toBe(0x1234n);
        expect(bigintFrom("1234", "$")).toBe(1234n);
    });

    it("rejects non-hex and empty instead of decoding to zero", () => {
        expect(() => hexInt("", "$")).toThrow(/hex integer/);
        expect(() => hexInt("0x", "$")).toThrow(/hex integer/);
        expect(() => hexInt("0xzz", "$")).toThrow(/hex integer/);
        expect(() => hexInt(42, "$")).toThrow(/expected a string/);
    });
});

describe("bool", () => {
    it("rejects the truthy stand-ins JSON often carries", () => {
        expect(bool(true, "$")).toBe(true);
        expect(bool(false, "$")).toBe(false);
        expect(() => bool(1, "$")).toThrow(/expected a boolean/);
        expect(() => bool("true", "$")).toThrow(/expected a boolean/);
        expect(() => bool(null, "$")).toThrow(/got null/);
    });
});

describe("hexBytes", () => {
    it("accepts prefixed and bare hex, including empty", () => {
        expect(hexBytes("0xdead", "$")).toEqual(new Uint8Array([0xde, 0xad]));
        expect(hexBytes("dead", "$")).toEqual(new Uint8Array([0xde, 0xad]));
        expect(hexBytes("0x", "$")).toEqual(new Uint8Array());
    });

    it("rejects odd length and non-hex instead of emitting zero bytes", () => {
        // Per-byte `parseInt` would turn "zz" into NaN and then 0, decoding
        // corrupt input to plausible-looking data.
        expect(() => hexBytes("0xabc", "$")).toThrow(/even-length hex/);
        expect(() => hexBytes("zz", "$")).toThrow(/even-length hex/);
        expect(() => hexBytes(5, "$")).toThrow(/expected a string/);
    });
});

describe("tuple2 / mapArr / opt", () => {
    it("threads the index into the error path", () => {
        expect(pathOf(() => tuple2(["1", "x"], "$.clueR", bigintFrom))).toBe("$.clueR[1]");
        expect(pathOf(() => mapArr(["1", "2", null], "$.roots", bigintFrom))).toBe("$.roots[2]");
    });

    it("maps a well-formed array", () => {
        expect(tuple2(["1", "2"], "$", bigintFrom)).toEqual([1n, 2n]);
        expect(mapArr([1, 2, 3], "$", int)).toEqual([1, 2, 3]);
    });

    it("passes undefined and null through as undefined", () => {
        expect(opt(undefined, "$", str)).toBeUndefined();
        expect(opt(null, "$", str)).toBeUndefined();
        expect(opt("x", "$", str)).toBe("x");
        expect(() => opt(5, "$", str)).toThrow(/expected a string/);
    });
});

describe("errors", () => {
    it("are typed WIRE_FORMAT and carry the path", () => {
        let err: unknown;
        try {
            obj(1, "$.body");
        } catch (e) {
            err = e;
        }
        expect(isWalletError(err, "WIRE_FORMAT")).toBe(true);
        expect((err as { path: string }).path).toBe("$.body");
        expect((err as Error).message).toContain("at $.body");
    });
});
