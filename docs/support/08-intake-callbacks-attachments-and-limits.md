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
removes the object and tombstones the row. Downloads recheck current case/evidence access and return short-lived
signed URLs. Large binaries go directly to Supabase Storage rather than through
the application server. Submitted evidence is retained; pending uploads can be
withdrawn according to the case rules.

Staff send neutral evidence prompts to the delivering consultant, presenter-tier
collaborators or current host representatives; crew collaborators are never asked. Recipients see the prompt, due time and their own submission,
not customer correspondence or private operator notes. The request remains linked
to the parent case for staff investigation and decision tracking.

## Deprecated & Superseded Approaches

Ticket attachment wrappers, legacy storage URL signing and attachment aliases were
removed. Use case evidence endpoints and private storage metadata directly; no
attachment metadata import or historical URL rewriting is required.
