// Wire-format (de)serializers for the relayer HTTP protocol.
//
// Outbound bigint encoding is not uniform, and must not be made uniform: the
// relayer's Rust DTOs declare the same three fields of the same struct
// differently.
//
//   POST /v1/intent   DepositIntent.{chainId,publicAssetId,publicIn}
//                     -> decimal strings (the DTO declares them String)
//   POST /v1/swap     swap.intentD, same three fields
//                     -> JSON numbers   (the DTO declares them u64, and
//                        serde's u64 deserializer rejects strings)
//
// Unifying them from the SDK side breaks one endpoint or the other. The choice
// is explicit at every call site through `u64Num` and `decStr` rather than a
// bare `Number(...)` or `.toString()`; `codec.test.ts` pins both encodings
// with golden fixtures.

import { bigintFrom, hexBytes, int, mapArr, obj, tuple2 } from "../../core/decode.js";
import { WireFormatError } from "../../core/errors.js";
import { bytesToHex } from "../../core/hex.js";
import type { Field, Point } from "../../crypto/index.js";
import type { AuxOutput } from "../../protocol/deposit-intent.js";
import type { ScannedNote } from "../../protocol/responses.js";
import type {
    SubmitIntentPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
    TransactAux,
    TransactPubInputs,
} from "../../protocol/transact.js";

/** @internal */
export interface SerializedScannedNote {
    ciphertext: string; // hex
    clueR: [string, string];
    ephPub: [string, string];
    cm: string;
    leafIndex: number;
}

/** @internal */
export interface SerializedMerkleProof {
    leafIndex: number;
    pathElements: string[][];
    pathIndices: number[];
    root: string;
}

/** @internal */
export interface SerializedTreeState {
    leafCount: number;
    root: string;
    frontier: string[][];
}

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
        proof2x2: p.proof2x2,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
    };
}

/** @internal */
export function serializeSubmitSwap(p: SubmitSwapPayload): unknown {
    return {
        chainId: u64Num(p.chainId, "$.chainId"),
        proof2x2: p.proof2x2,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
        swap: serializeSwapBlob(p.swap),
    };
}

function serializeSwapBlob(s: SwapBlob): unknown {
    return {
        adapter: s.adapter,
        route: s.route,
        intentD: {
            // Rust DTO declares these as u64 (serde rejects strings); JS
            // Number is safe up to 2^53.
            chainId: u64Num(s.intentD.chainId, "$.swap.intentD.chainId"),
            publicAssetId: u64Num(s.intentD.publicAssetId, "$.swap.intentD.publicAssetId"),
            publicIn: u64Num(s.intentD.publicIn, "$.swap.intentD.publicIn"),
            payer: s.intentD.payer,
            recipient: s.intentD.recipient,
            outCm: s.intentD.outCm,
            cvDep: [decStr(s.intentD.cvDep[0]), decStr(s.intentD.cvDep[1])],
            rcv: decStr(s.intentD.rcv),
        },
        auxD: serializeAux(s.auxD),
        tokenIn: s.tokenIn,
        tokenOut: s.tokenOut,
        // Decimal strings so U256 values >2^53 round-trip safely.
        amountIn: decStr(s.amountIn),
        minOut: decStr(s.minOut),
        deadline: s.deadline === undefined ? null : decStr(s.deadline),
    };
}

/** @internal */
export function serializeSubmitIntent(p: SubmitIntentPayload): unknown {
    return {
        chainId: u64Num(p.chainId, "$.chainId"),
        intent: {
            // Decimal strings here — /v1/intent's DTO declares them String.
            chainId: decStr(p.intent.chainId),
            publicAssetId: decStr(p.intent.publicAssetId),
            publicIn: decStr(p.intent.publicIn),
            payer: p.intent.payer,
            recipient: p.intent.recipient,
            outCm: p.intent.outCm,
        },
        permit2: {
            nonce: decStr(p.permit2.nonce),
            deadline: decStr(p.permit2.deadline),
            maxTotal: decStr(p.permit2.maxTotal),
            signature: p.permit2.signature,
        },
        aux: serializeAuxOutput(p.aux),
    };
}

/** @internal */
export function deserializeScannedNote(raw: unknown, path = "$"): ScannedNote {
    const d = obj(raw, path);
    return {
        ciphertext: hexBytes(d.ciphertext, `${path}.ciphertext`),
        clueR: tuple2(d.clueR, `${path}.clueR`, bigintFrom) as Point,
        ephPub: tuple2(d.ephPub, `${path}.ephPub`, bigintFrom) as Point,
        cm: bigintFrom(d.cm, `${path}.cm`),
        leafIndex: int(d.leafIndex, `${path}.leafIndex`),
    };
}

/** @internal */
export function deserializeMerkleProof(
    raw: unknown,
    path = "$",
): {
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    root: Field;
} {
    const d = obj(raw, path);
    return {
        leafIndex: int(d.leafIndex, `${path}.leafIndex`),
        pathElements: mapArr(d.pathElements, `${path}.pathElements`, (lvl, p) =>
            mapArr(lvl, p, bigintFrom),
        ),
        pathIndices: mapArr(d.pathIndices, `${path}.pathIndices`, int),
        root: bigintFrom(d.root, `${path}.root`),
    };
}

/** @internal */
export function deserializeTreeState(
    raw: unknown,
    path = "$",
): {
    leafCount: number;
    root: Field;
    frontier: Field[][];
} {
    const d = obj(raw, path);
    return {
        leafCount: int(d.leafCount, `${path}.leafCount`),
        root: bigintFrom(d.root, `${path}.root`),
        frontier: mapArr(d.frontier, `${path}.frontier`, (lvl, p) => mapArr(lvl, p, bigintFrom)),
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
