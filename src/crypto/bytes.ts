// Little-endian field-element byte conversions.
//
// The implementation lives in `core/bytes.ts` (tier 0) so `core/random.ts`
// can use it without depending on `crypto/`. Re-exported here because this
// is where callers expect to find it.

export { FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
