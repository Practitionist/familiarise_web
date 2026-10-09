# Support, feedback and review tests — shared setup

> **Required reading for every lane in `prompts/support-feedback-review-tests/`.**
> This file is the single source of truth for run parameters, hard rules, sign-in recipes, rate-limit budgeting, fixture discipline and the report format. If a lane file disagrees with this file, this file wins.

---

## 1. Run parameters

The orchestrator fills these in once per run and pastes them at the top of every lane prompt.

| Parameter | Meaning | Example shape |
| --- | --- | --- |
| `{PR_NUMBER}` | Pull request under test, or `none` for a post-merge run on `dev` | `2025` |
| `{PREVIEW_URL}` | Netlify deploy preview base URL | `https://deploy-preview-{PR_NUMBER}--familiarise.netlify.app` |
| `{HEAD_SHA}` | Pull-request head commit the preview was built from | 9-character short SHA |
| `{BRANCH}` | Pull-request branch | `feat/…` |
| `{RUN_DATE}` | Date of the run in `YYYY-MM-DD` | `2026-10-09` |
| `{RUN_TAG}` | Text tag put into every row the run writes | `[QA-{PR_NUMBER}]` |
| `{AUDIT_DIR}` | Gitignored folder for reports, jars and screenshots | `.claude/audits/{RUN_DATE}-support-e2e/` |

The first request to each route on a preview may cold-boot for 30 to 60 seconds. Retry once before calling a timeout a failure.

---

## 2. Hard rules

1. Do not spawn sub-agents. Do not edit any repository file. Write only inside `{AUDIT_DIR}` and, for temporary credentials, `/tmp/qa-{PR_NUMBER}/`.
2. Stay on the checkout you were given. Never check out, stash, commit or push.
3. The preview shares the production database. Treat every write as touching production: tag it, record it, and revert it.
4. Never run `next dev`, `next build`, `prisma db push` or `npm run db:*`. Never replay a webhook. Never submit dispute evidence (`POST /api/payments/disputes`). Never actually submit a GitHub issue; only read the generated URL.
5. Never ban or suspend a real seed account. Use ban or suspend only through the API against a throwaway account the run created, otherwise mark the case BLOCKED.
6. Every database write is a fixture. Tag text fields with `{RUN_TAG}`, record table, id and the original values of any updated row in the report's Fixtures section, and revert or delete at the end of the lane. Rows created through the UI count as fixtures too.
7. Poll in the foreground. Never end a turn waiting for something.
8. If you approach a session limit, write the report with the finished cases and mark the rest NOT RUN.
9. Keep the final chat message to the orchestrator under 250 words: counts, the FAIL list and the report path.

---

## 3. Seed roster

The authoritative account list and the shared seed password are in [`docs/team/mock-credentials.md`](../../../docs/team/mock-credentials.md). Do not copy ids or emails beyond that roster into any committed file. Lane 01 discovers the fixture ids for the run (appointments, occurrences, tickets, consultant profiles) and writes them to `{AUDIT_DIR}/fixtures.json`, which is gitignored.

---

## 4. Signing in

### Browser

Use the chrome-devtools MCP with one page. Open `{PREVIEW_URL}/auth/signin`, fill email and password, submit. Switch roles by signing out and in again. A staff or admin account with two-factor enabled shows an "Enter your authenticator code" step after the password; enter a code from the generator in section 5.

### curl with a cookie jar

```bash
mkdir -p /tmp/qa-{PR_NUMBER}
curl -s -c /tmp/qa-{PR_NUMBER}/daniel.jar \
  -H "Content-Type: application/json" \
  -H "Origin: {PREVIEW_URL}" \
  -d '{"email":"daniel.brown@gmail.com","password":"<seed password>"}' \
  "{PREVIEW_URL}/api/auth/sign-in/email"
```

Every later call sends `-b /tmp/qa-{PR_NUMBER}/daniel.jar -H "Origin: {PREVIEW_URL}"`. Mutating calls without the `Origin` header are rejected. Reuse jars; never sign in again just to refresh. A staff or admin operator has a single-session policy, so signing in elsewhere revokes the jar; sign in again and replace the jar.

---

## 5. Staff and admin two-factor enrolment

The back office returns `428 TWO_FACTOR_REQUIRED` with header `X-Auth-Action: enroll-2fa` for staff and admin accounts that have no authenticator. Lane 01 records which operators are enrolled. If the lanes need the back office, enrol one staff and one admin operator as follows. Enrolment is a database write: record it as a fixture and revert it in lane 06.

### Enrol through the API

1. Sign in and keep the jar.
2. `POST /api/auth/two-factor/enable` with body `{"password":"<seed password>"}`. The response carries a `totpURI` (its `secret` query parameter is the base32 secret) and a list of `backupCodes`. Save both into `/tmp/qa-{PR_NUMBER}/totp.json`, which must never be committed.
3. Compute the current six-digit code with the generator below and `POST /api/auth/two-factor/verify-totp` with `{"code":"<code>"}`.
4. Re-request `GET /api/staff/support-inbox`; it must now return 200 instead of 428.

### Enrol through the UI

Sign in as the operator. The app redirects to `/auth/two-factor/setup` ("Secure your staff account"). Confirm the password, read the manual key from the QR panel, enter a six-digit code from the generator, save the backup codes, and continue. The later sign-in shows "Enter your authenticator code" with a backup-code link.

### RFC 6238 generator

Save as `/tmp/qa-{PR_NUMBER}/totp.mjs` and run `node /tmp/qa-{PR_NUMBER}/totp.mjs <base32-secret>`.

```js
import crypto from "node:crypto";
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32(s) {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, t = Date.now()) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac("sha1", b32(secret)).update(c).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0");
}
if (process.argv[2]) console.log(totp(process.argv[2]));
```

### Reverting enrolment

`POST /api/auth/two-factor/disable` does not work for operators: it returns `403` with `{"code":"TWO_FACTOR_REQUIRED","message":"Two-factor authentication is required for staff."}`. Revert in lane 06 with SQL, after confirming the exact column names with `information_schema.columns` for `"twoFactor"` and `users`:

```sql
delete from "twoFactor" where "userId" in ('<staff id>','<admin id>');
update users set "twoFactorEnabled" = false where id in ('<staff id>','<admin id>');
```

Then verify that both `"twoFactor"` rows are gone and `twoFactorEnabled` is false for both users, and delete the local secrets file.

---

## 6. Rate-limit budgeting

| Limiter | Budget | Shared by |
| --- | --- | --- |
| `spamLimiter` | 5 per hour per user | Ticket create, ticket replies, ticket attachments, platform feedback, `/api/report`, platform-support escalation, and the private session rating |
| `reviewWriteLimiter` | 20 per hour per user | Public review create, edit, delete and reply |
| Sign-in | 30 per 15 minutes per IP | All sign-ins from the run machine |

Planning rules:

1. Plan at least three consultee accounts for the whole run so that one exhausted `spamLimiter` does not block a later lane. Spend each account's five writes deliberately and note the spend in the report.
2. A deduplicated platform-escalation replay still burns a token.
3. Run every limiter-exhaustion case last in its lane, and run the review-write limit case last in its lane, because exhaustion locks the account for up to an hour.
4. Never sign in more than needed; reuse jars and the single browser session.
5. A 429 body carries `retryAfterSeconds`; record it and compare it with the copy the UI shows.

---

## 7. Fixture tagging and cleanup discipline

1. Tag every text field you control with `{RUN_TAG}`: ticket subject and description, reply bodies, review text, feedback text, report descriptions, moderator notes.
2. Before any update of an existing row, `select` the original values and store them in the report. For a `ConsultantProfile` that means every score column (`publishedRatingOneToOne`, `publishedRatingGroup`, `ratedClientsOneToOne`, `ratedEventsGroup`) and `ratingAggregatedAt`. A recompute is not a restore: restore with an explicit `update` to the recorded values and re-read to verify.
3. Rows that cannot be edited back to a no-op (immutable revision tables) are removed by deleting their parent.
4. Besides the domain tables, sweep `"FailedEmail"` (a queued retry would re-send mail) and `"NotificationOutbox"` (match on `entityRef` and on payload text).
5. The ticket reference counter is not rewound; record how many references the run consumed.
6. Public profile pages are served from the incremental cache for about five minutes, and the public review list is edge-cached for about two minutes. After restoring scores, expect stale public reads for that long and do not report them as a restore failure.
7. External side effects that cannot be removed (in-app notifications in the notification vendor, a sign-in session row, uploaded storage objects) are listed as residue. Storage objects uploaded as attachments must be removed through the storage API.
8. Lane 06 performs the global sweep for `{RUN_TAG}` across every text column.

---

## 8. Classifying a defect as PR-specific or pre-existing

For every FAIL or PARTIAL, read the code at both refs and compare:

```bash
git show origin/dev:<path>
git show origin/{BRANCH}:<path>
```

Mark `[PR]` if the behaviour is introduced or changed by the diff and `[PRE]` if the same behaviour exists on `dev`. If the path is new in the branch, the defect is `[PR]`. Quote the suspected `file:line` at the PR head. Environment problems (for example schema drift in the live database) are marked `[ENV]`.

---

## 9. Browser hygiene

1. One page for the whole run. Use a second tab only when a case truly needs two sessions at once, and close extras at the end.
2. Desktop viewport.
3. Prefer `take_snapshot` (the accessibility tree) over screenshots. Take a screenshot only as evidence for a FAIL or PARTIAL and save it to `{AUDIT_DIR}/shots/L<n>-<case>.png`.
4. If the chrome profile is locked, fall back to `puppeteer-core` with the system Chrome in headless mode and a throwaway `userDataDir` such as `/tmp/fw-qa-<email>`.
5. Run `list_console_messages` and `list_network_requests` after each state change that matters.

---

## 10. Report format

Each lane writes `{AUDIT_DIR}/L<n>-report.md` with four sections.

1. **Verdict table.** Columns: `# | case | tag | PASS / FAIL / PARTIAL / BLOCKED / NOT RUN | one-line evidence`.
2. **Detail for every FAIL and PARTIAL.** Expected versus observed (quote status codes, response JSON fragments, row values and UI text), screenshot path, suspected `file:line` at the PR head, and the `[PR]` / `[PRE]` / `[ENV]` classification with the reason.
3. **UX and customer-psychology observations.** Judged as a frustrated customer, an expert, and a support agent would feel: copy, effort, dead ends, expectation setting, dark patterns.
4. **Fixtures.** Everything created or changed, original values, and what was reverted or deleted, or the exact SQL still pending.

A case is PASS only when an assertion was made on positively observed evidence. An empty result that would also appear if nothing had run is not a pass.
