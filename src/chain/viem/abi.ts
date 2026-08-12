// Contract ABIs. Pure data, declared apart from the calls that use them.
//
// `parseAbi` is a pure transform over string literals, but a bundler cannot
// know that: an un-annotated top-level call is a side effect, so every one of
// these anchors viem into any graph that so much as re-exports this module.
// The root barrel does, which made `import { isWalletError }` cost ~306 KB.
// `/* @__PURE__ */` is what lets the constants drop when unused.

import { parseAbi } from "viem";

export const MASP_ABI = /* @__PURE__ */ parseAbi([
    "function asset(uint64) view returns (address token, bool disabled, uint256 scale)",
    "function feeBps() view returns (uint16)",
    "function treasury() view returns (address)",
    "function cancelDelay() view returns (uint32)",
    "function WRAPPED_NATIVE() view returns (address)",
    "function nextIntentId() view returns (uint256)",
    "function escrowed(uint256) view returns (bytes32 digest, address payer, uint32 submittedAt, uint64 publicAssetId, uint16 feeBpsAtSubmit)",
    "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d,(uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig,(uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function submitIntentNative((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d,(uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) payable returns (uint256)",
    "function submitIntentAuthorized((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d,(uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function cancelIntent(uint256 id,uint48 publicIn,bytes32 cm0,bytes32 cm1,uint256[2] cvDep0,uint256[2] cvDep1)",
    "event IntentEscrowed(uint256 indexed id,address indexed payer,address indexed recipient,uint64 publicAssetId,uint64 publicIn,uint16 feeBpsAtSubmit,bytes32 cm0,bytes32 cm1,uint256 cvDep0X,uint256 cvDep0Y,uint256 cvDep1X,uint256 cvDep1Y,uint256 rcvTotal,uint256 clueRx0,uint256 clueRy0,uint256 ephPubX0,uint256 ephPubY0,bytes ciphertext0,uint256 clueRx1,uint256 clueRy1,uint256 ephPubX1,uint256 ephPubY1,bytes ciphertext1)",
    "event NotesCreated(bytes32 indexed cm0,bytes32 indexed cm1)",
    "event NotePayload(bytes32 indexed cm0,bytes32 indexed cm1,uint256 clueRx0,uint256 clueRy0,uint256 ephPubX0,uint256 ephPubY0,bytes ciphertext0,uint256 clueRx1,uint256 clueRy1,uint256 ephPubX1,uint256 ephPubY1,bytes ciphertext1,uint256 cvDep0X,uint256 cvDep0Y,uint256 cvDep1X,uint256 cvDep1Y)",
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
