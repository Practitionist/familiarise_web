# ADR: Both sides are told of a proposed negative session verdict, with the window's close in their zone and a link to report

- **Status**: Accepted (2026-11-24), built. The owner answered the four questions below on 2026-11-24.
- **Date**: 2026-11-24
- **Author**: Platform engineering
- **Builds on**: [A negative session outcome needs strong evidence, a participant report or an ops confirmation inside a report window](./2026-11-23-session-outcome-report-window.md), whose build-plan step 5 this is.

## Context

The outcome sweep (`decideSlotOutcome` in `lib/booking/session-outcome-sweep.ts`) classifies every past session from Stream's settled participant record. Three verdicts move money or a private record against a person: `HOST_ABSENT`, `CUT_SHORT` and `LEARNER_ABSENT`. Since the report-window decision, each of them is only proposed when the sweep writes it. Its money effect waits until `AppointmentOccurrence.outcomeConfirmedAt` is stamped: at the window's close (`outcomeAt` plus `OUTCOME_REPORT_WINDOW_HOURS`, 48 hours) on strong evidence, earlier when the harmed side agrees, or by ops.

A report window only works if the people who may report know it is open. Before this decision, the only notice was the 1:1 learner's `session-no-show` bell and `CLASS_SESSION_NO_SHOW` email, which said the session "counts as held" and named no deadline. The expert heard nothing about a learner absence, and nobody heard anything about a host absence or a cut-short session until the remedy ran. The support copy promised "an automatic full refund" for an expert no-show without saying when, which the window made untrue.

## Peers

- **Preply** and **italki** send no reminder before the confirmation window closes. The lesson auto-confirms on silence, and the report door is on the lesson itself ([Preply auto-confirmation](https://help.preply.com/en/articles/4179432-how-lesson-auto-confirmation-works), [italki incomplete lessons](https://support.italki.com/hc/en-us/articles/360023118333)).
- **Topmate** (India) refunds a follower's no-show report automatically when the expert does not resolve it within 72 hours ([Topmate no-show handling](https://topmate72420835211887570.freshdesk.com/support/solutions/articles/1070000111307-handling-no-show-issues-as-an-expert-on-topmate)).

What carries over is a single notice at the moment of the claim, a fixed deadline in it, and silence settling the verdict. Where we differ: our notice goes to both sides, and silence settles only a verdict on strong evidence; a weak one goes to ops.

## Decision

### 1. A proposed-verdict notice to both sides, bell and email

When the sweep writes `HOST_ABSENT`, `CUT_SHORT` or `LEARNER_ABSENT`, every host (`sessionHostUserIds`: the consultant, accepted collaborators, the trial's expert) and every live learner seat that is not a host gets one bell (`session-outcome-proposed`) and one email (`SESSION_OUTCOME_PROPOSED`). It says:

- what the platform recorded;
- when the window closes, `outcomeAt` plus 48 hours, in the recipient's own zone;
- what happens if nobody replies, including the refund amount for a consultation, formatted from paise;
- that our team checks the call record first if it is incomplete;
- a link to report: the recipient's own support request page for the booking, `?intent=NO_SHOW&occurrence=<id>`.

The options weighed were the learner only (the old notice), the accused side only, or both sides. **Chosen: both sides**, because either side may report and a report from either can confirm or hold the verdict. The notice is an event in the existing `appointment` Novu family, not a new workflow: the plan caps an environment at 20 workflows, and the 16 families already in use leave little room.

A learner's refund is named by where it goes, read from that seat's own payment legs: a card-paid seat is refunded to the learner, and a seat an organisation's wallet, invoice or licence paid for is returned to the organisation ("we'll return it to your organisation, which paid for your seat, automatically"), because the refund cascade reverses each leg to its source.

The notice is staged in the verdict's own transaction and attempted after the commit. If it cannot be prepared, the sweep defers the session and writes no verdict that run, so the report window (which starts at `outcomeAt`) never starts unannounced; the next pass writes the verdict and stages the notice together. Deferral was chosen over a stored, retryable notice intent because it needs no new state: a deferred session moves no money, and the 72-hour `INCONCLUSIVE` park is untouched, since an unreadable record is not a negative verdict. It is read and rendered before the transaction (`prepareProposedOutcomeNotices` in `lib/booking/outcome-notices.ts`), and staged only when the transaction's compare-and-set moved the row (`stageOutcomeNotices`). Each bell is keyed `session-outcome-proposed:<occurrence>:<outcomeAt>:<user>`, so a person gets one notice per verdict, and a re-run of the sweep cannot write the verdict twice. The words come from `proposedNoticeCopy` (`lib/booking/outcome-notice-copy.ts`), shared by the bell and the email.

### 2. No reminder before the window closes

The options were a reminder some hours before the close, or none. **Chosen: none**, as Preply and italki do. One notice at the claim carries the deadline, and a second notice per verdict would double the Novu runs for a deadline the first one already names.

### 3. Refund copy gives the exact date, or sooner

A notice that knows the date gives it: "We'll refund ₹1,500.00 automatically after Wed, 25 Nov 2026 · 5:15 PM IST, or sooner if you confirm the expert didn't join." Static copy that cannot know the date says it in words: "after a 48-hour window from our record, or sooner if you confirm". This replaces every promise of "an automatic full refund" or an immediate refund:

- the learner's "The expert never showed up" terminal in `lib/support/flows.ts`;
- `CONSULTATION_HOST_NO_SHOW_ANSWER` and `SUBSCRIPTION_HOST_NO_SHOW_ANSWER` in `lib/support/session-outcome-copy.ts`, and the use-case pages that show them;
- the refund policy's section 3.5 (`app/(pages)/refund/page.tsx`) and the no-shows help article (`app/support/_data/support-content.ts`);
- the host's "your fee for this session stays with you" (`attendee_no_show`), which now waits for the window.

The strike stays private. The expert's notice of a consultation host absence says the miss is added to a reliability record "which only you and our team see". A learner's notice never mentions a strike.

A void that is not a consultation host absence is refunded by the settle sweep 14 days after the void (`MAKEUP_WINDOW_DAYS`), so its notice names that date instead: for a class or webinar, the date by which the expert must hold a make-up; for a consultation cut short, the date after which it is refunded. A subscription session returns to the plan's allowance, and a trial session does not count as held.

### 4. Later notices reuse what exists, plus one review notice

The options were a new notice at every later step, or reuse. **Chosen: reuse**: the learner's `refund-processed` bell when the refund lands, and the expert's strike only on their own dashboard card. One notice is added: when ops change a negative verdict to any other outcome through `session.set-outcome`, both sides get one short `session-outcome-reviewed` bell and `SESSION_OUTCOME_REVIEWED` email ("We've reviewed your session"), staged in the overturn's transaction by `setSessionOutcome` (`lib/backoffice/session-outcomes.ts`). It is rendered before the transaction for the verdict read then and staged only if that verdict still stands under the lock. It goes out for any change away from a negative verdict, a disputed one or a weak one on the needs-human list alike, because both sides were told of the verdict either way.

## Consequences

- The appointment family gains two events and loses `session-no-show`, so the app has 102 events. The family body changes, so Novu needs a sync (see "Operations").
- `CLASS_SESSION_NO_SHOW` is no longer sent; the 1:1 learner's notice is the proposed-verdict notice, which also names the recording when one exists. A group seat absent from a held, recorded session still gets `session-missed-recording`.
- Every notice is an optional `appointments` notice, so a person who turned appointment notices off gets neither the bell nor the email.

## Operations

`npm run novu:sync -- --dry-run`, then `npm run novu:sync` against Development, then two clean `npm run novu:check` runs five minutes apart. Production is synced with the release promotion that carries this change, never before.

## Not verified here

- The notices on a deploy preview: previews refuse job runs, so the sweep never writes a verdict there. The unit tests stage the rows against mocked reads.
- The rendered bell in the Novu inbox before the sync: the family body is written by the sync.

## Deprecated & Superseded Approaches

- **`session-no-show` and `CLASS_SESSION_NO_SHOW` (replaced 2026-11-24).** The learner of a 1:1 session recorded `LEARNER_ABSENT` was told the session "counts as held" and to contact support if they could not get in, with no deadline, and the expert was told nothing. The proposed-verdict notice replaces both, for both sides.
- **"An automatic full refund" for an expert no-show (replaced 2026-11-24).** The support flow, the FAQ answers and the refund policy promised a refund with no timing. The refund now waits for the report window, and the copy says so.
