// URL coercion. SDK clients accept either a `URL` instance or a string.

/** HTTP(S) base URL, or a filesystem path where the context allows one. */
export type Url = string | URL;

/** Stringify a `Url` for consumers that accept either a path or a URL string. */
export function urlToString(u: Url): string {
    return u instanceof URL ? u.href : u;
}

/**
 * Whether `u` is an `http(s)` URL rather than a filesystem path or `file://`
 * href.
 *
 * The dividing line for three separate decisions: whether to read bytes off
 * disk or over the network, and whether the Cache API can key on it (it stores
 * `Request`s, which must be http(s)).
 */
export function isHttpUrl(u: string): boolean {
    return /^https?:\/\//.test(u);
}
