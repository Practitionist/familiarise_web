# Intake, callbacks and private evidence

Appointment Get help attaches booking context; account/platform help creates the
same canonical case shape. Organization intake selects explicit operations or
billing ownership and verifies current membership. Public grievances keep external
name/email fields rather than impersonating the queue custodian.

Intake validates strings and raw enums with Zod and verifies linked appointments,
payments and organizations server-side. A customer-supplied organization tag is
not an authorization grant. Callback phone/window are structured case fields;
forged callback markers in text are stripped at the existing intake boundaries.
Receipts include the reference and stored deadline; automated receipts do not
stamp human acknowledgement.

Evidence metadata is validated before issuing a direct signed upload to the
private support-attachments bucket. Completion verifies the stored content type
and size. Downloads recheck current case/evidence access and return short-lived
signed URLs. Large binaries go directly to Supabase Storage rather than through
the application server. Submitted evidence is retained; pending uploads can be
withdrawn according to the case rules.

Staff send neutral evidence prompts to eligible delivery participants or current
host representatives. Recipients see the prompt, due time and their own submission,
not customer correspondence or private operator notes. The request remains linked
to the parent case for staff investigation and decision tracking.

## Deprecated & Superseded Approaches

Ticket attachment wrappers, legacy storage URL signing and attachment aliases were
removed. Use case evidence endpoints and private storage metadata directly; no
attachment metadata import or historical URL rewriting is required.
