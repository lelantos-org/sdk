// Credential redaction for URLs that reach log lines and error messages.

// Query params that carry a credential, matched case-insensitively. Unlisted
// params are preserved.
const SECRET_PARAMS = new Set(["token", "fmdsecret", "detectionkey", "detectionkeyhex"]);
// Path prefixes whose final segment is a bearer token, not a resource id.
const SECRET_PATH_PREFIXES = ["/v1/subscriptions/"];

/**
 * Strip credentials from a URL. Host, path shape and param names are
 * preserved, so the result remains diagnosable.
 *
 * An unparseable URL yields `<unparseable url>` rather than passing through,
 * since a credential may sit somewhere this function does not inspect.
 */
export function redactUrl(raw: string): string {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "<unparseable url>";
    }

    for (const key of [...u.searchParams.keys()]) {
        if (SECRET_PARAMS.has(key.toLowerCase())) u.searchParams.set(key, "REDACTED");
    }
    for (const prefix of SECRET_PATH_PREFIXES) {
        if (u.pathname.startsWith(prefix) && u.pathname.length > prefix.length) {
            u.pathname = `${prefix}REDACTED`;
        }
    }
    return u.toString();
}
