## Preview QA — 2026-11-04

**Result: preview checks passed where data permitted; the server-side money changes are not fully exercised by this run.** No new blocking regression found in the tested surfaces.

Tested [deploy-preview-2579](https://deploy-preview-2579--familiarise.netlify.app) at **`874858f25df728377bff91b631932176e49452cd`**. The Netlify PR comment and the browser's deploy ID `6aeb16a48c04d0698ec020fb` agree. Read the description, QA prompt, review body and inline feedback. The previously flagged garbled plan-end sentence is corrected at this head.

UI testing used **Chrome DevTools MCP**, database census used **Supabase MCP SELECTs**, and release checks used **Sentry MCP**. No Computer Use, code edits, money jobs, webhook replays, refund submissions or hold/release actions.

| QA case | Verdict | Evidence |
|---|---|---|
| 1. Impact census | **PASS** | Ran both runbook §5 predicates across both earnings arms. Matured `PENDING` earnings on an owed marker: **0**. Owed marker joined to its own `SUCCEEDED` refund: **0**. `READY` consultant earnings on an owed marker: **0**; organisation earnings: **0**. No sample IDs exist for either empty result. Spent, non-deleted markers: **5**. |
| 2. Needs-human copy | **PASS** | Admin `GET /api/admin/refunds/needs-human` returned **200**, with **5** `stuck-owed-refund` items. Every message ends **“Its earnings stay held until this is settled.”** All five also render in the Refunds page. [Screenshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2579/admin-refunds.jpg?raw=true) · [snapshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2579/admin-refunds.snapshot.txt). |
| 3. Already-sent form walk | **BLOCKED — no data** | Case 1(b) returned zero rows. Did not fabricate a money fixture or submit a refund. The already-sent refusal and stale-marker clearing remain untested in this preview run. |
| 4. Expert earnings regression | **PARTIAL** | Grace's page loads with no console errors. Available **₹0**, Pending **₹16,000**, Paid out **₹2,40,000**, Lifetime **₹2,56,000** render. No applicable owed-marker earning was available to verify its particular status/wording. [Screenshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2579/expert-earnings.jpg?raw=true) · [snapshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2579/expert-earnings.snapshot.txt). |
| 5. Back-office smoke | **PARTIAL — prompt differs from permissions** | As `qa-staff-1`, Refunds, Payouts and Support inbox → **Needs reply** load, with no console errors or observed 5xx. Refund list GET: **200**. `GET /api/backoffice/nav-counts?tree=staff`: **200**. Staff Earnings redirects to Payments by the current capability matrix; there is no staff Earnings nav item. Admin Earnings was tested instead and loads with no console errors. Admin nav counts with `?tree=admin`: **200**, including refunds **5**, payouts **12**, support **4**. [Staff refunds](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2579/staff-refunds.jpg?raw=true) · [staff payouts](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2579/staff-payouts.jpg?raw=true) · [admin earnings](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2579/admin-earnings.jpg?raw=true). |
| 6. Sentry | **PARTIAL — no reported issues, limited telemetry** | Exact-release search in `practitionist/familiarise_web` returned **no issues**; release metadata reports `newIssues: 0`. Both `firstEvent` and `lastEvent` are null. This is not proof that every preview failure would be captured. |

### Findings and polish

- **QA prompt correction:** `/api/backoffice/nav-counts` requires `?tree=admin` or `?tree=staff`. The bare URL returns **403**, including for an admin. The product itself calls the correct URL. Ask an admin to test Earnings; the staff redirect is expected authorization behavior. The inbox is labelled **Needs reply**, not “Needs-you.”
- **P3, queue readability:** the new held-earnings sentence is clear. Each item still embeds a long payment ID and raw dedupe key such as `cancel:<id>:<id>` in one paragraph. A readable reason and copyable IDs, with the dedupe key in details, would make the next action easier to identify. This is a polish suggestion, not a demonstrated regression in the new hold.
- **Coverage limit:** release gating, attempt counting, marker clearing and the already-sent refusal are **not runtime-verified here**. No background money job was run. The PR's unit/DB-test claims were read, not rerun or re-certified by this browser QA pass.

### Cleanup

No domain-data writes for #2579. Signed out after testing. Normal sign-in/session and application telemetry may remain; no money state was changed. The separate #2580 mock-fixture run was cleaned up and is documented on that PR.

[All #2579 evidence](https://github.com/Practitionist/familiarise_web/tree/qa-artifacts/qa/2579)
