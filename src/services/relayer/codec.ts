// Wire-format serializers for the relayer HTTP protocol.
//
// Outbound bigint encoding is not uniform. The relayer's Rust DTOs declare a
// `DepositRequest`'s `chainId`, `publicAssetId` and `publicIn` as `u64`, and
// serde's `u64` deserializer rejects strings, so those three go out as JSON
// numbers while every field element and U256 beside them goes out as a decimal
// string. The choice is explicit at every call site through `u64Num` and
// `decStr` rather than a bare `Number(...)` or `.toString()`; `codec.test.ts`
// pins both encodings with golden fixtures.

import { bytesToHex } from "../../core/hex.js";
import type { Point } from "../../crypto/index.js";
import { WireFormatError } from "../../errors/network.js";
import type { OutputAux } from "../../notes/aux.js";
import type { DepositRequest } from "../../protocol/deposit-request.js";
import type {
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
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
        depositD: serializeSwapDeposit(s.depositD, "$.swap.depositD"),
        auxD: serializeAux(s.auxD),
        feeAuxD: serializeAux(s.feeAuxD),
        refundD: serializeSwapDeposit(s.refundD, "$.swap.refundD"),
        refundAuxD: serializeAux(s.refundAuxD),
        refundFeeAuxD: serializeAux(s.refundFeeAuxD),
        tokenIn: s.tokenIn,
        tokenOut: s.tokenOut,
        // Decimal strings so U256 values >2^53 round-trip safely.
        amountIn: decStr(s.amountIn),
        minOut: decStr(s.minOut),
        deadline: decStr(s.deadline),
        refundTo: s.refundTo,
    };
}

function serializeSwapDeposit(d: DepositRequest, path: string): unknown {
    return {
        // Rust DTO declares these as u64 (serde rejects strings); JS
        // Number is safe up to 2^53.
        chainId: u64Num(d.chainId, `${path}.chainId`),
        publicAssetId: u64Num(d.publicAssetId, `${path}.publicAssetId`),
        publicIn: u64Num(d.publicIn, `${path}.publicIn`),
        payer: d.payer,
        recipient: d.recipient,
        outCm: d.outCm,
        cvDep: [decStr(d.cvDep[0]), decStr(d.cvDep[1])],
        rcv: decStr(d.rcv),
        // A swap deposit mints a fee leaf too, paying whoever flushes it. Its
        // asset is a `u64` like `feeIn`: the escrowed asset, or 0 for a
        // zero-value leaf.
        feeAssetId: u64Num(d.feeAssetId, `${path}.feeAssetId`),
        feeIn: u64Num(d.feeIn, `${path}.feeIn`),
        feeCm: d.feeCm,
        feeCvDep: [decStr(d.feeCvDep[0]), decStr(d.feeCvDep[1])],
        feeRcv: decStr(d.feeRcv),
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
        intentHash: decStr(pi.intentHash),
        outCvDep: pi.outCvDep.map(pointToObj),
    };
}

function serializeAux(a: OutputAux): unknown {
    return {
        clueR: pointToObj(a.clueR),
        ephPub: pointToObj(a.ephPub),
        ciphertext: bytesToHex(a.ciphertext),
    };
}
