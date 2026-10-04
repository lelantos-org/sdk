// Contract ABIs, declared apart from the calls that use them.
//
// A bundler treats an un-annotated top-level `parseAbi` call as a side effect,
// which would anchor viem into any graph that re-exports this module.
// `/* @__PURE__ */` lets unused constants be dropped.
//
// The Lelantos entries are a hand-maintained subset of the ABI that
// `@lelantos-org/contracts` ships; `abi.test.ts` asserts each matches on inputs
// and outputs. The package's `maspAbi` is one constant that cannot be shaken
// per entry, so it is not imported at runtime.

import { parseAbi } from "viem";

export const MASP_ABI = /* @__PURE__ */ parseAbi([
    "function asset(uint64 id) view returns ((address token, bool disabled, uint16 depositBps, uint16 withdrawBps, bool isYield, uint48 scale))",
    "function assetFees(uint64 id) view returns (uint16 depositBps, uint16 withdrawBps)",
    // The yield mixin's state in one view. `venue` is the zero address for an
    // id that does not yield.
    "function yieldState(uint64 id) view returns ((address venue, uint16 bufferBps, uint16 perfBps, bool halted, uint256 totalNormalized, uint256 accruedFeeNormalized, uint256 idle, uint256 lastIdx, uint256 index))",
    "function treasury() view returns (address)",
    "function cancelDelay() view returns (uint32)",
    "function nextDepositId() view returns (uint256)",
    "function escrowed(uint256 id) view returns (bytes32 digest)",
    "function isKnownRoot(bytes32 root) view returns (bool)",
    "function deposit((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 inner, uint64 feeAssetId, uint64 feeIn, bytes32 feeInner) d, (uint256 nonce, uint256 deadline, uint256 maxTotal, uint256 maxFee, bytes signature) sig, (uint256 clueRx, uint256 clueRy, uint256 clueQx, uint256 clueQy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 clueQx, uint256 clueQy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) returns (uint256 id)",
    "function depositAuthorized((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 inner, uint64 feeAssetId, uint64 feeIn, bytes32 feeInner) d, (uint256 clueRx, uint256 clueRy, uint256 clueQx, uint256 clueQy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 clueQx, uint256 clueQy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) returns (uint256 id)",
    // `pulled` is the escrow's refund cap: the underlying pulled at submit for
    // a yield asset, in the deposit asset's token, and zero for a plain one. It
    // is the last word of the escrow digest preimage, so a cancel hands back the
    // value `DepositEscrowed` published.
    "function cancelDeposit(uint256 id, uint48 publicIn, bytes32 inner, uint64 publicAssetId, uint16 fbps, address payer, uint32 submittedAt, (uint48 feeIn, uint64 feeAssetId, bytes32 feeInner) feeNote, uint256 pulled) returns (uint256 total, uint256 feeRefunded)",
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 inner, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint64 feeAssetId, uint64 feeIn, bytes32 feeInner, uint256 feeClueRx, uint256 feeClueRy, uint256 feeEphPubX, uint256 feeEphPubY, bytes feeCiphertext, uint256 pulled)",
    // `feeRefunded` is nonzero only when the relayer note was paid in another
    // asset, and is then in `feeAssetId`'s token; otherwise the fee is inside
    // `refunded`.
    "event DepositCanceled(uint256 indexed id, address indexed payer, uint256 refunded, uint64 feeAssetId, uint256 feeRefunded)",
    "event NotePayload(bytes32 indexed cm, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext)",
]);

/**
 * `NativeAdapter`: the native-coin bridge for the ERC-20-only pool, deployed at
 * its own address.
 *
 * The adapter wraps on the way in and unwraps on the way out. A native deposit
 * is sent to it with `d.payer` set to the adapter, the party the pool pulls
 * from and refunds.
 *
 * Such an escrow is cancelled through `cancelNative`: `MASP.cancelDeposit`
 * refunds the digest-bound payer, only a contract payer itself may cancel its
 * deposits, and the adapter's `escrows` mapping is the only record of who
 * funded the escrow.
 */
export const NATIVE_ADAPTER_ABI = /* @__PURE__ */ parseAbi([
    "function POOL() view returns (address)",
    "function WRAPPED_NATIVE() view returns (address)",
    "function escrows(uint256 id) view returns (address refundTo, uint256 amount)",
    "function depositNative((uint256 chainId, uint64 publicAssetId, uint64 publicIn, address payer, address recipient, bytes32 inner, uint64 feeAssetId, uint64 feeIn, bytes32 feeInner) d, (uint256 clueRx, uint256 clueRy, uint256 clueQx, uint256 clueQy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) aux, (uint256 clueRx, uint256 clueRy, uint256 clueQx, uint256 clueQy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext) feeAux) payable returns (uint256 id)",
    "function cancelNative(uint256 id, uint48 publicIn, bytes32 inner, uint64 publicAssetId, uint16 fbps, uint32 submittedAt, (uint48 feeIn, uint64 feeAssetId, bytes32 feeInner) feeNote, uint256 pulled)",
    "event NativeDeposited(uint256 indexed id, address indexed refundTo, uint256 escrowed, uint256 returned)",
    "event NativeRefunded(uint256 indexed id, address indexed refundTo, uint256 amount)",
]);

/**
 * The venue leg of a yield asset's gross position.
 *
 * One deployment per yield asset. The venue reports what is lent out and the
 * pool its idle balance; their sum is the asset's `gross`.
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
 * The `PermitBatch` overload of `permit`. One overload per constant keeps
 * `functionName: "permit"` unambiguous for `encodeFunctionData` at both call
 * sites.
 */
export const PERMIT2_PERMIT_BATCH_ABI = /* @__PURE__ */ parseAbi([
    "function permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline) permitBatch,bytes signature)",
]);
