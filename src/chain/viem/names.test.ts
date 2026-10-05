import * as contracts from "@lelantos-org/contracts";
import {
    decodeFunctionData,
    keccak256,
    pad,
    stringToBytes,
    toEventSelector,
    toFunctionSelector,
    zeroAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import { ERC20_ABI, NAME_REGISTRAR_ABI } from "./abi.js";
import {
    encodeApprove,
    encodeRegisterName,
    HANDLE_REGISTERED_TOPIC,
    handleRegisteredIn,
} from "./name-calls.js";
import { readNameAvailable, readNameFee, readNameRecord } from "./names.js";

const REGISTRAR = `0x${"4e".repeat(20)}`;
const CONTROLLER = `0x${"c0".repeat(20)}`;
const TOKEN = `0x${"a1".repeat(20)}`;

/** A client answering `readContract` from a table keyed by function name. */
function client(answers: Record<string, unknown>) {
    const calls: { functionName: string; address: string; args?: readonly unknown[] }[] = [];
    return {
        calls,
        readContract: (async (req: {
            functionName: string;
            address: string;
            args?: readonly unknown[];
        }) => {
            calls.push(req);
            return answers[req.functionName];
        }) as never,
    };
}

describe("registrar reads", () => {
    it("reads a registered record", async () => {
        const c = client({ recordOf: ["lelantos1value", CONTROLLER, 3n] });
        expect(await readNameRecord(c, REGISTRAR, "mehow")).toEqual({
            registered: true,
            value: "lelantos1value",
            controller: CONTROLLER,
            nonce: 3n,
        });
        expect(c.calls[0]).toMatchObject({ address: REGISTRAR, args: ["mehow"] });
    });

    it("reports an unregistered label, and a cleared one as registered", async () => {
        const none = await readNameRecord(
            client({ recordOf: ["", zeroAddress, 0n] }),
            REGISTRAR,
            "x",
        );
        expect(none).toMatchObject({ registered: false, value: "" });
        const cleared = await readNameRecord(
            client({ recordOf: ["", CONTROLLER, 1n] }),
            REGISTRAR,
            "x",
        );
        expect(cleared).toMatchObject({ registered: true, value: "" });
    });

    it("reads availability and the fee", async () => {
        const c = client({ available: true, feeToken: TOKEN, feeAmount: 5_000_000n });
        expect(await readNameAvailable(c, REGISTRAR, "mehow")).toBe(true);
        expect(await readNameFee(c, REGISTRAR)).toEqual({ token: TOKEN, amount: 5_000_000n });
    });
});

describe("registration calldata", () => {
    it("encodes register(label, value, controller)", () => {
        const data = encodeRegisterName("mehow", "lelantos1value", CONTROLLER) as `0x${string}`;
        const decoded = decodeFunctionData({ abi: NAME_REGISTRAR_ABI, data });
        expect(decoded.functionName).toBe("register");
        expect(decoded.args?.[0]).toBe("mehow");
        expect(decoded.args?.[1]).toBe("lelantos1value");
        expect(String(decoded.args?.[2]).toLowerCase()).toBe(CONTROLLER);
    });

    it("encodes the fee approval", () => {
        const data = encodeApprove(REGISTRAR, 5_000_000n) as `0x${string}`;
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
        expect(decoded.functionName).toBe("approve");
        expect(String(decoded.args?.[0]).toLowerCase()).toBe(REGISTRAR);
        expect(decoded.args?.[1]).toBe(5_000_000n);
    });

    it("pins the registration event's topic", () => {
        expect(HANDLE_REGISTERED_TOPIC).toBe(
            toEventSelector("HandleRegistered(bytes32,address,string)"),
        );
    });
});

describe("handleRegisteredIn", () => {
    const registration = { registrar: REGISTRAR, label: "mehow", controller: CONTROLLER };
    const log = (over: { address?: string; label?: string; controller?: string } = {}) => ({
        address: (over.address ?? REGISTRAR) as never,
        topics: [
            HANDLE_REGISTERED_TOPIC,
            keccak256(stringToBytes(over.label ?? "mehow")),
            pad((over.controller ?? CONTROLLER) as `0x${string}`),
        ] as never,
    });

    it("finds the registrar's event for the label and the controller", () => {
        expect(handleRegisteredIn([log()], registration)).toBe(true);
        // Addresses compare without regard to case.
        expect(
            handleRegisteredIn([log({ address: REGISTRAR.toUpperCase().replace("0X", "0x") })], {
                ...registration,
                controller: CONTROLLER.toUpperCase().replace("0X", "0x"),
            }),
        ).toBe(true);
    });

    it("ignores another label, another controller, another emitter and an empty receipt", () => {
        expect(handleRegisteredIn([], registration)).toBe(false);
        expect(handleRegisteredIn([log({ label: "other" })], registration)).toBe(false);
        expect(handleRegisteredIn([log({ controller: TOKEN })], registration)).toBe(false);
        expect(handleRegisteredIn([log({ address: TOKEN })], registration)).toBe(false);
    });
});

// The hand-written subset against the canonical ABI, once the installed `@lelantos-org/contracts`
// carries the registrar.
describe("NAME_REGISTRAR_ABI vs the canonical ABI", () => {
    type Item = { type: string; name?: string; inputs?: readonly { type: string }[] };
    const canonical = (contracts as Record<string, unknown>).lelantosNameRegistrarAbi as
        | readonly Item[]
        | undefined;
    const signature = (i: Item) => `${i.name}(${(i.inputs ?? []).map((p) => p.type).join(",")})`;

    it.skipIf(canonical === undefined)("declares only what the contract declares", () => {
        const known = new Set(
            (canonical ?? [])
                .filter((i) => i.type === "function" || i.type === "event")
                .map((i) => `${i.type} ${signature(i)}`),
        );
        for (const item of NAME_REGISTRAR_ABI as readonly Item[]) {
            expect(known, `${item.type} ${signature(item)}`).toContain(
                `${item.type} ${signature(item)}`,
            );
        }
    });

    it("keeps the selectors the relayer allowlists", () => {
        expect(toFunctionSelector("register(string,string,address)")).toBe("0x5664d69c");
        expect(toFunctionSelector("setValue(string,string,uint256,bytes)")).toBe("0x6372c204");
    });
});
