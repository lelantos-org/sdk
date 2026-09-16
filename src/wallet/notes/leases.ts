// In-flight note leases.
//
// A spend selects its notes long before it learns whether they were consumed:
// between selection and the relayer's answer it syncs the tree, proves and
// submits. Two spends running concurrently in one wallet would otherwise read
// the same unspent set and pick the same notes, and the second proof would be
// rejected as a double spend after a full Groth16 run.
//
// A lease withholds a note from every other selection while its spend is in
// flight. Selection and leasing happen under one lock, so no other selection
// can observe the note set between them. The spend settles the lease: the note
// is marked spent (success) or reserved (unknown outcome) *before* the lease is
// released, and a definite failure releases it untouched.
//
// In memory only. A lease guards a live operation; after a restart nothing is
// in flight, and an unknown outcome is carried by `StoredNote.pendingSpendAt`.

import { createMutex } from "../../core/async.js";
import { InternalError } from "../../errors/base.js";

export class NoteLeases {
    private readonly held = new Set<string>();
    private readonly lock = createMutex();

    /**
     * Run a selection exclusively: nothing else selects or leases until `op` settles.
     *
     * Keep `op` short (read the tip, select, lease). Consolidation and proving run outside it, or
     * a spend's own consolidation would wait on itself.
     */
    select<T>(op: () => Promise<T>): Promise<T> {
        return this.lock.run(op);
    }

    /** `notes` without the ones an in-flight spend holds. */
    available<N extends { readonly id: string }>(notes: readonly N[]): N[] {
        return this.held.size === 0 ? [...notes] : notes.filter((n) => !this.held.has(n.id));
    }

    /**
     * Take `ids` for one spend.
     *
     * Throws when any is already held: a selection that saw only {@link available} notes cannot
     * pick one, so a clash is an SDK bug, and continuing would double-spend.
     */
    lease(ids: readonly string[]): void {
        const clash = ids.filter((id) => this.held.has(id));
        if (clash.length > 0) {
            throw new InternalError(`note lease: ${clash.length} note(s) already held by a spend`, {
                details: { notes: clash.length },
            });
        }
        for (const id of ids) this.held.add(id);
    }

    /** Return `ids` to selection. Unknown ids are ignored, so a double release is harmless. */
    release(ids: readonly string[]): void {
        for (const id of ids) this.held.delete(id);
    }

    /** Whether an in-flight spend holds `id`. */
    has(id: string): boolean {
        return this.held.has(id);
    }

    /** Notes currently held. */
    get size(): number {
        return this.held.size;
    }
}
