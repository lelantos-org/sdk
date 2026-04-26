// Uniswap Permit2 signing.
//
// Tier 4, beside `chain/` rather than inside it: the signatures are a protocol
// concern the chain adapter consumes, so they must not sit above it.

export {
    type SignPermit2AllowanceArgs,
    type SignPermit2Args,
    signPermit2Allowance,
    signPermit2Witness,
} from "./sign.js";
