// Contract ABIs, declared apart from the calls that use them.
//
// `parseAbi` is a pure transform, but a bundler treats an un-annotated
// top-level call as a side effect, so each constant would anchor viem into any
// graph that re-exports this module, including the root barrel.
// `/* @__PURE__ */` lets unused constants be dropped.
//
// The Lelantos entries are generated from `@lelantos-org/contracts` (the
// Foundry build), and `abi.test.ts` asserts each matches on inputs and outputs.
// They are inlined rather than imported because `maspAbi` is a single 30 KB
// constant that cannot be shaken per entry; the subset here is ~3 KB.

import { parseAbi } from "viem";

export const MASP_ABI = /* @__PURE__ */ parseAbi([
    "function asset(uint64 id) view returns ((address token, bool disabled, uint16 depositBps, uint16 withdrawBps, uint256 scale))",
    "function assetFees(uint64 id) view returns (uint16 depositBps, uint16 withdrawBps)",
    // The yield mixin: one view rather than a getter per mapping, because the
    // pool is close to the EIP-170 limit. It also tells whether an asset yields
    // at all: `venue` is the zero address for a plain id.
    "function yieldState(uint64 id) view returns ((address venue, uint16 bufferBps, uint16 perfBps, bool halted, uint256 totalNormalized, uint256 accruedFeeNormalized, uint256 idle, uint256 lastIdx, uint256 index))",
    "function treasury() view returns (address)",
    "function cancelDelay() view returns (uint32)",
    "function nextDepositId() view returns (uint256)",
    "function escrowed(uint256 id) view returns (bytes32 digest)",
    "function isKnownRoot(bytes32 root) view returns (bool)",
    "function deposit((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 outCm, uint256[2] cvDep, uint256 rcv, uint64 feeAssetId, uint64 feeIn, bytes32 feeCm, uint256[2] feeCvDep, uint256 feeRcv) d, (uint256 nonce, uint256 deadline, uint256 maxTotal, uint256 maxFee, bytes signature) sig, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) returns (uint256 id)",
    "function depositAuthorized((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 outCm, uint256[2] cvDep, uint256 rcv, uint64 feeAssetId, uint64 feeIn, bytes32 feeCm, uint256[2] feeCvDep, uint256 feeRcv) d, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) returns (uint256 id)",
    "function cancelDeposit(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, address payer, uint32 submittedAt, (uint48 feeIn, uint64 feeAssetId, bytes32 feeCm, uint256[2] feeCvDep) feeNote) returns (uint256 total, uint256 feeRefunded)",
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm, uint256 cvDepX, uint256 cvDepY, uint256 rcv, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint64 feeAssetId, uint64 feeIn, bytes32 feeCm, uint256 feeCvDepX, uint256 feeCvDepY, uint256 feeRcv, uint256 feeClueRx, uint256 feeClueRy, uint256 feeEphPubX, uint256 feeEphPubY, bytes feeCiphertext)",
    // `feeRefunded` is nonzero only when the relayer note was paid in another
    // asset, and is then in `feeAssetId`'s token; otherwise it is inside
    // `refunded`.
    "event DepositCanceled(uint256 indexed id, address indexed payer, uint256 refunded, uint64 feeAssetId, uint256 feeRefunded)",
    "event NotePayload(bytes32 indexed cm, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint256 cvDepX, uint256 cvDepY)",
]);

/**
 * `NativeAdapter` — the native-coin bridge for an ERC-20-only MASP.
 *
 * The pool never holds native coin: the adapter wraps on the way in and
 * unwraps on the way out. It is a separate contract address, not a second pool
 * entry point, so a native deposit is sent *here*, and `d.payer` must be the
 * adapter, since it is the party the pool pulls from and refunds.
 *
 * `cancelNative` follows from that ownership: `MASP.cancelDeposit` refunds the
 * digest-bound payer, which for these escrows is the adapter, and the pool
 * restricts contract payers to cancelling their own deposits. The adapter's
 * `escrows` mapping is the only record of who funded the escrow, so it is the
 * only path that can return the coin.
 */
export const NATIVE_ADAPTER_ABI = /* @__PURE__ */ parseAbi([
    "function POOL() view returns (address)",
    "function WRAPPED_NATIVE() view returns (address)",
    "function escrows(uint256 id) view returns (address refundTo, uint256 amount)",
    "function depositNative((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 outCm, uint256[2] cvDep, uint256 rcv, uint64 feeAssetId, uint64 feeIn, bytes32 feeCm, uint256[2] feeCvDep, uint256 feeRcv) d, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) payable returns (uint256 id)",
    "function cancelNative(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, uint32 submittedAt, (uint48 feeIn, uint64 feeAssetId, bytes32 feeCm, uint256[2] feeCvDep) feeNote)",
    "event NativeDeposited(uint256 indexed id, address indexed refundTo, uint256 escrowed, uint256 returned)",
    "event NativeRefunded(uint256 indexed id, address indexed refundTo, uint256 amount)",
]);

/**
 * The venue leg of a yield asset's gross position.
 *
 * A separate deployment per yield asset, so not part of `MASP_ABI`. The pool
 * reports the idle balance and the units outstanding, the venue reports what is
 * lent out; the two are summed to get the `gross` the pool divides by.
 */
export const YIELD_VENUE_ABI = /* @__PURE__ */ parseAbi([
    "function totalAssets() view returns (uint256)",
]);

export const ERC20_ABI = /* @__PURE__ */ parseAbi([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
]);

export const WETH_DEPOSIT_ABI = /* @__PURE__ */ parseAbi(["function deposit() payable"]);

export const PERMIT2_VIEW_ABI = /* @__PURE__ */ parseAbi([
    "function allowance(address user,address token,address spender) view returns (uint160,uint48,uint48)",
]);

export const PERMIT2_PERMIT_ABI = /* @__PURE__ */ parseAbi([
    "function permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature)",
]);

/**
 * The `PermitBatch` overload of `permit`, in its own ABI.
 *
 * Two entries of the same name in one ABI require every `encodeFunctionData`
 * call to disambiguate by argument shape. One overload per const keeps
 * `functionName: "permit"` unambiguous at both call sites.
 */
export const PERMIT2_PERMIT_BATCH_ABI = /* @__PURE__ */ parseAbi([
    "function permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline) permitBatch,bytes signature)",
]);
