// Relayer HTTP client.
//
// The wire types live in `protocol/` — this module is the transport plus its
// codec. Exports are explicit: the serializers in `codec.ts` are internal and
// stay off the `./relayer` subpath.

export { RelayerClient } from "./client.js";
