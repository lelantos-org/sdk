// Wire-format (de)serializers for the relayer HTTP protocol.
//
// Outbound bigint encoding is not uniform, and must not be made uniform: the
// relayer's Rust DTOs declare the same three fields of the same struct
// differently.
//
//   POST /v1/deposit   DepositRequest.{chainId,publicAssetId,publicIn}
//                     -> decimal strings (the DTO declares them String)
//   POST /v1/swap     swap.depositD, same three fields
//                     -> JSON numbers   (the DTO declares them u64, and
//                        serde's u64 deserializer rejects strings)
//
// Unifying them from the SDK side breaks one endpoint or the other. The choice
// is explicit at every call site through `u64Num` and `decStr` rather than a
// bare `Number(...)` or `.toString()`; `codec.test.ts` pins both encodings
// with golden fixtures.

import { WireFormatError } from "../../core/errors.js";
import { bytesToHex } from "../../core/hex.js";
import type { Point } from "../../crypto/index.js";
import type { AuxOutput } from "../../protocol/deposit-request.js";
import type {
    SubmitDepositPayload,
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

/** @internal */
export function serializeSubmitDeposit(p: SubmitDepositPayload): unknown {
    return {
        chainId: u64Num(p.chainId, "$.chainId"),
        deposit: {
            // Decimal strings here — /v1/deposit's DTO declares them String.
            chainId: decStr(p.deposit.chainId),
            publicAssetId: decStr(p.deposit.publicAssetId),
            publicIn: decStr(p.deposit.publicIn),
            payer: p.deposit.payer,
            recipient: p.deposit.recipient,
            outCm: p.deposit.outCm,
            // The leaf's value commitment and its blinder. Both are fields of
            // `PubInputs.DepositRequest`, so a relayer cannot rebuild the
            // struct without them — `rcv` in particular is a private witness
            // it has no other way to learn.
            cvDep: [decStr(p.deposit.cvDep[0]), decStr(p.deposit.cvDep[1])],
            rcv: decStr(p.deposit.rcv),
            // The relayer's own fee note. It needs every field to rebuild the
            // escrow digest, and `feeRcv` to build the batch witness for that
            // leaf.
            feeIn: decStr(p.deposit.feeIn),
            feeCm: p.deposit.feeCm,
            feeCvDep: [decStr(p.deposit.feeCvDep[0]), decStr(p.deposit.feeCvDep[1])],
            feeRcv: decStr(p.deposit.feeRcv),
        },
        permit2: {
            nonce: decStr(p.permit2.nonce),
            deadline: decStr(p.permit2.deadline),
            maxTotal: decStr(p.permit2.maxTotal),
            signature: p.permit2.signature,
        },
        aux: serializeAuxOutput(p.aux),
        feeAux: serializeAuxOutput(p.feeAux),
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

function serializeAuxOutput(a: AuxOutput): unknown {
    return {
        clueRx: decStr(a.clueRx),
        clueRy: decStr(a.clueRy),
        ephPubX: decStr(a.ephPubX),
        ephPubY: decStr(a.ephPubY),
        ciphertext: bytesToHex(a.ciphertext),
    };
}
