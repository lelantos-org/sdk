// Wire-format serializers for the relayer HTTP protocol.
//
// Outbound bigint encoding is not uniform. Fields the relayer's Rust DTOs
// declare as `u64` go out as JSON numbers through `u64Num`, since serde's `u64`
// deserializer rejects strings; field elements and U256 values go out as
// decimal strings through `decStr`. `codec.test.ts` pins both encodings.

import { bytesToHex } from "../../core/hex.js";
import type { Point } from "../../crypto/index.js";
import { WireFormatError } from "../../errors/network.js";
import type { OutputAux } from "../../notes/aux.js";
import type { DepositRequest } from "../../protocol/deposit-request.js";
import type {
    GenericBlob,
    SubmitGenericPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
    TransactPubInputs,
} from "../../protocol/transact.js";

/**
 * Encode as a JSON number, for a field whose Rust DTO is `u64`.
 *
 * @throws {WireFormatError} if negative or above `Number.MAX_SAFE_INTEGER`,
 * where `Number(bigint)` would truncate silently.
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
        amountIn: decStr(s.amountIn),
        minOut: decStr(s.minOut),
        deadline: decStr(s.deadline),
        refundTo: s.refundTo,
    };
}

/** @internal */
export function serializeSubmitGeneric(p: SubmitGenericPayload): unknown {
    return {
        chainId: u64Num(p.chainId, "$.chainId"),
        proof: p.proof,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
        generic: serializeGenericBlob(p.generic),
    };
}

function serializeGenericBlob(g: GenericBlob): unknown {
    return {
        amountIn: decStr(g.amountIn),
        calls: g.calls.map((c) => ({ target: c.target, value: decStr(c.value), data: c.data })),
        outputs: g.outputs.map((o, i) => ({
            minOut: decStr(o.minOut),
            deposit: serializeSwapDeposit(o.deposit, `$.generic.outputs[${i}].deposit`),
            aux: serializeAux(o.aux),
            feeAux: serializeAux(o.feeAux),
        })),
        deadline: decStr(g.deadline),
        minGas: decStr(g.minGas),
        refundTo: g.refundTo,
        surplusTo: g.surplusTo,
        refundD: serializeSwapDeposit(g.refundD, "$.generic.refundD"),
        refundAuxD: serializeAux(g.refundAuxD),
        refundFeeAuxD: serializeAux(g.refundFeeAuxD),
    };
}

function serializeSwapDeposit(d: DepositRequest, path: string): unknown {
    return {
        chainId: u64Num(d.chainId, `${path}.chainId`),
        publicAssetId: u64Num(d.publicAssetId, `${path}.publicAssetId`),
        publicIn: u64Num(d.publicIn, `${path}.publicIn`),
        payer: d.payer,
        recipient: d.recipient,
        inner: d.inner,
        // Fee leaf, paying whoever flushes the deposit. `feeAssetId` is the
        // escrowed asset, or 0 for a zero-value leaf.
        feeAssetId: u64Num(d.feeAssetId, `${path}.feeAssetId`),
        feeIn: u64Num(d.feeIn, `${path}.feeIn`),
        feeInner: d.feeInner,
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
        publicOut: u64Num(pi.publicOut, "$.pubInputs.publicOut"),
        digest: decStr(pi.digest),
        recipient: pi.recipient,
        chainId: u64Num(pi.chainId, "$.pubInputs.chainId"),
        payer: pi.payer,
        relayer: pi.relayer,
        intentHash: decStr(pi.intentHash),
    };
}

function serializeAux(a: OutputAux): unknown {
    return {
        clueR: pointToObj(a.clueR),
        clueQ: pointToObj(a.clueQ),
        ephPub: pointToObj(a.ephPub),
        ciphertext: bytesToHex(a.ciphertext),
    };
}
