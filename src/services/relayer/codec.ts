// Wire-format serializers for the relayer HTTP protocol.
//
// Outbound bigint encoding is not uniform. The relayer's Rust DTOs declare a
// `DepositRequest`'s `chainId`, `publicAssetId` and `publicIn` as `u64`, and
// serde's `u64` deserializer rejects strings, so those three go out as JSON
// numbers while every field element and U256 beside them goes out as a decimal
// string. The choice is explicit at every call site through `u64Num` and
// `decStr` rather than a bare `Number(...)` or `.toString()`; `codec.test.ts`
// pins both encodings with golden fixtures.

import { WireFormatError } from "../../core/errors.js";
import { bytesToHex } from "../../core/hex.js";
import type { Point } from "../../crypto/index.js";
import type {
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
    TransactAux,
    TransactPubInputs,
} from "../../protocol/transact.js";

/**
 * Encode as a JSON number, for a field whose Rust DTO is `u64`.
 *
 * @throws {WireFormatError} above `Number.MAX_SAFE_INTEGER`. `Number(bigint)`
 * truncates silently, and `publicAssetId` is an uncapped u64, so an asset id
 * past 2^53 would corrupt the wire with no indication.
 */
function u64Num(v: bigint, path: string): number {
    if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WireFormatError(
            path,
            `value ${v} does not fit a JSON number (max ${Number.MAX_SAFE_INTEGER})`,
        );
    }
    return Number(v);
}

/** Encode as a decimal string, for a field whose Rust DTO is `String`. */
function decStr(v: bigint): string {
    return v.toString();
}

/** @internal */
export function serializeSubmitTransact(p: SubmitTransactPayload): unknown {
    return {
        chainId: u64Num(p.chainId, "$.chainId"),
        kind: p.kind,
        proof: p.proof,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
    };
}

/** @internal */
export function serializeSubmitSwap(p: SubmitSwapPayload): unknown {
    return {
        chainId: u64Num(p.chainId, "$.chainId"),
        proof: p.proof,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
        swap: serializeSwapBlob(p.swap),
    };
}

function serializeSwapBlob(s: SwapBlob): unknown {
    return {
        adapter: s.adapter,
        route: s.route,
        depositD: {
            // Rust DTO declares these as u64 (serde rejects strings); JS
            // Number is safe up to 2^53.
            chainId: u64Num(s.depositD.chainId, "$.swap.depositD.chainId"),
            publicAssetId: u64Num(s.depositD.publicAssetId, "$.swap.depositD.publicAssetId"),
            publicIn: u64Num(s.depositD.publicIn, "$.swap.depositD.publicIn"),
            payer: s.depositD.payer,
            recipient: s.depositD.recipient,
            outCm: s.depositD.outCm,
            cvDep: [decStr(s.depositD.cvDep[0]), decStr(s.depositD.cvDep[1])],
            rcv: decStr(s.depositD.rcv),
            // The B-note deposit mints a fee leaf too, though the swap pays
            // the relayer on its spend leg, so this one is a zero-value pad.
            feeIn: u64Num(s.depositD.feeIn, "$.swap.depositD.feeIn"),
            feeCm: s.depositD.feeCm,
            feeCvDep: [decStr(s.depositD.feeCvDep[0]), decStr(s.depositD.feeCvDep[1])],
            feeRcv: decStr(s.depositD.feeRcv),
        },
        auxD: serializeAux(s.auxD),
        feeAuxD: serializeAux(s.feeAuxD),
        tokenIn: s.tokenIn,
        tokenOut: s.tokenOut,
        // Decimal strings so U256 values >2^53 round-trip safely.
        amountIn: decStr(s.amountIn),
        minOut: decStr(s.minOut),
        deadline: s.deadline === undefined ? null : decStr(s.deadline),
    };
}

function pointToObj(p: Point): { x: string; y: string } {
    return { x: decStr(p[0]), y: decStr(p[1]) };
}

function serializePubInputs(pi: TransactPubInputs): unknown {
    return {
        merkleRoot: decStr(pi.merkleRoot),
        nullifier: pi.nullifier.map(decStr),
        outCm: pi.outCm.map(decStr),
        publicAssetId: u64Num(pi.publicAssetId, "$.pubInputs.publicAssetId"),
        publicIn: u64Num(pi.publicIn, "$.pubInputs.publicIn"),
        publicOut: u64Num(pi.publicOut, "$.pubInputs.publicOut"),
        inCv: pi.inCv.map(pointToObj),
        outCv: pi.outCv.map(pointToObj),
        recipient: pi.recipient,
        chainId: u64Num(pi.chainId, "$.pubInputs.chainId"),
        payer: pi.payer,
        relayer: pi.relayer,
        outCvDep: pi.outCvDep.map(pointToObj),
    };
}

function serializeAux(a: TransactAux): unknown {
    return {
        clueR: pointToObj(a.clueR),
        ephPub: pointToObj(a.ephPub),
        ciphertext: bytesToHex(a.ciphertext),
    };
}
