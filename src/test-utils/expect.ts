// Assertion helpers shared by the suites.

/** Settle `p` and return what it rejected with, failing the test if it resolved. */
export async function rejection(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
    try {
        await (typeof p === "function" ? p() : p);
    } catch (err) {
        return err;
    }
    throw new Error("expected a rejection");
}
