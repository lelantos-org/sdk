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
 * Decides whether bytes are read from disk or over the network, and whether the
 * Cache API can key on the URL (it stores `Request`s, which must be http(s)).
 */
export function isHttpUrl(u: string): boolean {
    return /^https?:\/\//.test(u);
}

/**
 * In a browser, resolve a page-relative reference to an absolute URL; anywhere
 * else, and for anything already absolute, return it unchanged.
 *
 * Self-hosted apps commonly pass a relative artifact base (`"/artifacts"`), which
 * fetches correctly but fails {@link isHttpUrl}, losing artifact persistence (a
 * ~48 MB re-download on every page load). Resolving it also gives the byte cache
 * one canonical key, so two spellings of one artifact cannot cause two downloads
 * and two prover sessions.
 *
 * Outside a browser a bare string is a filesystem path, which `new URL()` would
 * corrupt.
 */
export function toAbsoluteUrl(u: string): string {
    if (isHttpUrl(u)) return u;
    const href = (globalThis as { location?: { href?: string } }).location?.href;
    if (!href) return u;
    try {
        return new URL(u, href).href;
    } catch {
        return u;
    }
}
