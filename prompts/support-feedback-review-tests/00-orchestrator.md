# Orchestrator playbook — support, feedback and review E2E

> You are the orchestrator. Read [`_shared/shared-setup.md`](./_shared/shared-setup.md) and [`_shared/complaint-catalogue.md`](./_shared/complaint-catalogue.md) first. You launch the lane agents, verify what they report, put judgement calls to the owner, and publish the result. You do not run the cases yourself, and you do not edit product code during a QA run.

---

## 1. Model and effort tiers

| Role | Agent type | Model and effort | Notes |
| --- | --- | --- | --- |
| Orchestrator | the main session | Opus, high effort | Sequencing, verification, decisions, synthesis |
| Lane runners 01 to 06 | `sweeper` | Sonnet, medium effort | Override the delivery section of the agent definition: lanes write reports only and open no pull request |
| Code verification | `Explore` | Sonnet | Read-only checks of a claimed `file:line` at the PR head or on `dev` |

Lane runners must not spawn sub-agents. Launch them in the background and wait for the completion notification; never predict a result before it arrives.

## 2. Before launching

1. Fill the run parameters from the shared setup section 1: `{PR_NUMBER}`, `{PREVIEW_URL}`, `{HEAD_SHA}`, `{BRANCH}`, `{RUN_DATE}`, `{RUN_TAG}`, `{AUDIT_DIR}`.
2. Confirm the preview is built from `{HEAD_SHA}` and the health route answers.
3. Fetch the refs you will compare: `git fetch origin dev {BRANCH}`. A stale `origin/dev` misattributes diffs, so fetch before every classification.
4. Create `{AUDIT_DIR}` (gitignored) with a `shots/` subfolder.
5. Warn the owner that the preview shares the production database and that the lanes write tagged fixtures into it.

## 3. Lane sequence

The lanes are strictly sequential, because they share fixture rows, rate-limit budgets and the single-session policy of operators.

| Order | Lane | Gate to continue |
| --- | --- | --- |
| 1 | `01-preflight-drift-and-fixtures.md` | No unexplained schema drift, sign-in works for every persona, fixtures discovered. If drift breaks a read path, stop and consult the owner before any other lane. |
| 2 | `02-customer-support-journey.md` | Handoff tickets recorded for lane 03 |
| 3 | `03-staff-support-operations.md` | Staff and admin two-factor enrolment recorded |
| 4 | `04-reviews-and-session-feedback.md` | Score columns restored and verified |
| 5 | `05-moderation-platform-feedback-disputes.md` | Dispute rows restored |
| 6 | `06-cleanup-and-sentry.md` | Global tag sweep returns zero rows |

Give each lane its prompt file, the run parameters, the path to the previous lane's report, and the handoff table it must honour.

## 4. After each lane

1. Read the report. Count verdicts and reconcile them against the case table of the lane file; every case must appear as PASS, FAIL, PARTIAL, BLOCKED or NOT RUN.
2. **Re-check every FAIL and every PARTIAL at the PR head yourself** (or with an `Explore` agent): read the cited `file:line` with `git show origin/{BRANCH}:<path>`, and compare with `git show origin/dev:<path>` to classify `[PR]`, `[PRE]` or `[ENV]`. Reject a FAIL that the code does not support, and demote or promote verdicts with the reason written into the synthesis.
3. Look for lane-induced artefacts before blaming the product: microsecond timestamps written by SQL that make every optimistic write conflict, a limiter exhausted by an earlier case, a cold-boot timeout, a single-session policy that revoked a jar.
4. Check the lane's fixtures section against the next lane's preconditions. If a lane left something half-reverted, fix it before continuing.
5. If a lane hit a session limit, relaunch only its NOT RUN cases as a new lane run; do not resume a stopped agent.

## 5. Decision points for the owner

Use `AskUserQuestion` for a product decision a lane cannot make. Put a plain-language explanation first, offer two or three concrete options with a recommendation, and record the answer in the synthesis. Typical decision points:

- A behaviour that is defensible either way (who may do an action, what a reply does to a status).
- A fix that changes a data policy (what staff may see, what is public).
- Whether a pre-existing defect is fixed in the pull request under test or filed as an issue.
- Whether an environment problem (schema drift) blocks the merge.

### Worked examples from the 2026-10-09 run

| Question | Decision taken | Resulting permanent regression case |
| --- | --- | --- |
| A staff reply raced a Resolve and left the ticket in progress with a resolved timestamp. What should a reply do? | A staff reply never reopens a resolved ticket. The expected status is part of the write condition, and the reply is still saved and sent. | SFR-03-18 |
| The callback phone was free text and a customer could forge the "callback requested" marker. | Validate the phone with a schema on the server, strip customer-typed markers, and trust only a marker the server wrote. | SFR-02-10, SFR-03-09 |
| The engineering escalation link pre-filled a public repository issue for every staff member. | Only admins see it, and the body carries the case key and reference only. | SFR-03-14 |
| Staff `CONTENT_REMOVED` on a review report removed the review although direct deletion is admin-only. | Removal of a review is admin-only everywhere. | SFR-05-09 |
| Staff dispute reads were widened and expose evidence and billing details. | Staff may read disputes, but evidence and billing PII are redacted unless the viewer may manage disputes. | SFR-05-18 |
| Excluding a review from the rating left it unlabelled and told nobody. | The review stays visible with a "Not counted in rating" label, and the expert and the reporter are notified. | SFR-05-06, SFR-05-07 |
| The live database lacked an earlier schema change, so every dispute read returned 500. | Treat as a P0 environment finding outside the pull request: the owner applies the schema, then the blocked dispute cases are re-run. | SFR-01-01, SFR-05-15 |

Note on the first row: the customer-side behaviour that a customer reply to a resolved ticket reopens it was observed as working and is kept as current behaviour in SFR-02-13. If the owner means that no reply of any kind reopens a resolved ticket, ask before changing that case.

## 6. Synthesis and publication

1. **Report.** Write `{AUDIT_DIR}/REPORT.md` with: verdict (merge, fix before merge, or block), counts per lane, defects introduced by the pull request (table with severity, where, owner decision, fix), cross-cutting findings outside the pull request, pre-existing defects, a complaint-to-result table covering the catalogue, and the cleanup result.
2. **Pull-request comment.** Post a short comment on the pull request: verdict, the list of `[PR]` defects each with file and line, and a link to nothing private. Never paste secrets, jars, TOTP data or fixture ids.
3. **Bucketed issues.** File one issue per bucket, not one per finding: storage and privacy, support UX and notifications, moderation and review transparency, seed and QA gaps, and environment drift when applicable. Each issue lists its findings with the case ids and a suggested fix. Do not close issues manually.
4. **Umbrella.** Create or update one umbrella tracking issue that links every bucket and the pull request, and keeps a checklist of the decisions taken.
5. **Suite maintenance.** If a lane found that a case in this suite is wrong or stale, note it in the synthesis so the suite is corrected in a separate documentation pull request.

## 7. Cleanup gate

Do not close the run until all of these hold:

- Lane 06's global sweep for `{RUN_TAG}` returned zero rows across every text column, including `FailedEmail` and `NotificationOutbox`.
- Every restored score row, dispute row and excluded flag matches the recorded original values.
- Staff and admin two-factor enrolment is reverted by SQL and local secrets and cookie jars are deleted.
- Residue that cannot be removed (vendor notifications, consumed ticket references, sign-in session rows) is listed in the report.
- The browser has one page left, or none.

If any item fails, relaunch lane 06 with the failing items before reporting.
