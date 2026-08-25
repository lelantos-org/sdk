// Contract ABIs. Pure data, declared apart from the calls that use them.
//
// `parseAbi` is a pure transform over string literals, but a bundler cannot
// know that: an un-annotated top-level call is a side effect, so every one of
// these anchors viem into any graph that so much as re-exports this module.
// The root barrel does, which made `import { isWalletError }` cost ~306 KB.
// `/* @__PURE__ */` is what lets the constants drop when unused.
//
// The Lelantos entries are generated from `@lelantos-org/contracts` (the
// Foundry build) rather than hand-written, and `abi.test.ts` asserts every one
// still matches, inputs and outputs. They are inlined instead of imported
// because `maspAbi` is a single 30 KB constant covering the whole contract:
// it cannot be shaken per-entry, and the subset here is ~3 KB.

import { parseAbi } from "viem";

export const MASP_ABI = /* @__PURE__ */ parseAbi([
    "function asset(uint64 id) view returns ((address token, bool disabled, uint256 scale))",
    "function feeBps() view returns (uint16)",
    "function treasury() view returns (address)",
    "function cancelDelay() view returns (uint32)",
    "function nextDepositId() view returns (uint256)",
    "function escrowed(uint256 id) view returns (bytes32 digest)",
    "function deposit((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 outCm, uint256[2] cvDep, uint256 rcv, uint64 feeIn, bytes32 feeCm, uint256[2] feeCvDep, uint256 feeRcv) d, (uint256 nonce, uint256 deadline, uint256 maxTotal, bytes signature) sig, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) returns (uint256 id)",
    "function depositAuthorized((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 outCm, uint256[2] cvDep, uint256 rcv, uint64 feeIn, bytes32 feeCm, uint256[2] feeCvDep, uint256 feeRcv) d, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) returns (uint256 id)",
    "function cancelDeposit(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, address payer, uint32 submittedAt, uint48 feeIn, bytes32 feeCm, uint256[2] feeCvDep)",
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm, uint256 cvDepX, uint256 cvDepY, uint256 rcv, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint64 feeIn, bytes32 feeCm, uint256 feeCvDepX, uint256 feeCvDepY, uint256 feeRcv, uint256 feeClueRx, uint256 feeClueRy, uint256 feeEphPubX, uint256 feeEphPubY, bytes feeCiphertext)",
    "event NotePayload(bytes32 indexed cm, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint256 cvDepX, uint256 cvDepY)",
]);

/**
 * `NativeAdapter` — the native-coin bridge for an ERC-20-only MASP.
 *
 * The pool never sees native coin: the adapter wraps on the way in and
 * unwraps on the way out. That makes it a second contract address, not a
 * second entry point, so a native deposit is sent *here* rather than to the
 * pool, and `d.payer` must be the adapter — it is the party the pool pulls
 * from and refunds.
 *
 * `cancelNative` exists because of that ownership: `MASP.cancelDeposit`
 * refunds the digest-bound payer, which for these escrows is the adapter,
 * and the pool restricts contract payers to cancelling their own deposits.
 * The adapter's own `escrows` mapping is the only record of who funded the
 * escrow, so it is the only path that can return the coin.
 */
export const NATIVE_ADAPTER_ABI = /* @__PURE__ */ parseAbi([
    "function POOL() view returns (address)",
    "function WRAPPED_NATIVE() view returns (address)",
    "function escrows(uint256 id) view returns (address refundTo, uint256 amount)",
    "function depositNative((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 outCm, uint256[2] cvDep, uint256 rcv, uint64 feeIn, bytes32 feeCm, uint256[2] feeCvDep, uint256 feeRcv) d, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) payable returns (uint256 id)",
    "function cancelNative(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, uint32 submittedAt, uint48 feeIn, bytes32 feeCm, uint256[2] feeCvDep)",
    "event NativeDeposited(uint256 indexed id, address indexed refundTo, uint256 escrowed, uint256 returned)",
    "event NativeRefunded(uint256 indexed id, address indexed refundTo, uint256 amount)",
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
