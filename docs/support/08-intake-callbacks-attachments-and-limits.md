# Intake, callbacks and private evidence

Appointment Get help attaches booking context; account/platform help creates the
same canonical case shape. Organization intake selects explicit operations or
billing ownership and verifies current membership. An operator filing for another
member may attach only the organization's own bookings, and the case is
organization-owned so access follows current membership. A signed-in public
grievance belongs to the account; an anonymous one keeps external name/email
fields on a case held by the non-staff public-intake system user.

Intake validates strings and raw enums with Zod and verifies linked appointments,
payments and organizations server-side. A customer-supplied organization tag is
not an authorization grant. Callback phone/window are structured case fields;
forged callback markers in text are stripped at the existing intake boundaries.
Receipts include the reference and stored deadline; automated receipts do not
stamp human acknowledgement.

Evidence metadata is validated before issuing a direct signed upload to the
private support-attachments bucket, whose size and MIME limits are set in code
from `lib/support/attachment-policy.ts`. Completion verifies the stored content
type and size and the file's leading bytes against the declared type; a mismatch
claims the pending row with a conditional tombstone before removing the object.
Downloads recheck current case/evidence access and return short-lived
signed URLs. Large binaries go directly to Supabase Storage rather than through
the application server. Submitted evidence is retained; pending uploads can be
withdrawn according to the case rules.

The attachment row exists before the upload URL is issued. Finalisation changes
that row from pending to completed only while `deletedAt` remains null. The orphan
crawler protects pending rows for 24 hours and only deletes objects older than
seven days. Before each support deletion batch of at most 100 paths, it
conditionally tombstones expired pending rows and rereads live references. A
completed row wins over a stale orphan snapshot; a cleanup claim blocks
finalisation. An in-flight finaliser that loses this race returns 409, while a
retry of an already completed live attachment remains successful.
The existing replay policy also accepts completed live evidence after the case
or evidence request closes. A pending upload still receives 409 on closure;
tombstoned evidence never qualifies as a completed replay.

Cleanup keeps the tombstone when storage deletion fails or the invocation stops
after its database claim. A later sweep retries grace-eligible surviving bytes;
the same attachment cannot be finalised again, and the user must upload a new file.
If immediate removal of a fresh rejected upload fails, its tombstoned object
still waits for the existing seven-day object grace before the crawler retries.
Server-generated unique paths and retained tombstones prevent path reuse. Storage
requests run outside the finalisation transaction. The crawler still lists whole
buckets; its 100-path ownership batches do not bound the complete invocation.

Staff send neutral evidence prompts to the delivering consultant, presenter-tier
collaborators or current host representatives; crew collaborators are never asked. Recipients see the prompt, due time and their own submission,
not customer correspondence or private operator notes. The request remains linked
to the parent case for staff investigation and decision tracking.

## Deprecated & Superseded Approaches

Ticket attachment wrappers, legacy storage URL signing and attachment aliases were
removed. Use case evidence endpoints and private storage metadata directly; no
attachment metadata import or historical URL rewriting is required.
Orphan snapshots alone no longer authorize deletion of a pending support upload;
the current attachment row determines whether finalisation or cleanup owns it.
