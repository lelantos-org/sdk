// URL coercion. SDK clients accept either a `URL` instance or a string.

/** HTTP(S) base URL, or a filesystem path where the context allows one. */
export type Url = string | URL;

/** Stringify a `Url` for consumers that accept either a path or a URL string. */
export function urlToString(u: Url): string {
    return u instanceof URL ? u.href : u;
}
