/**
 * ADR 20 for the notification layer.
 *
 * The list-helper allowlists (`org-scope-payload-allowlist.test.ts`) pin what
 * an organization can READ through the scoped queries. Nothing pinned what it
 * can be SENT. That gap matters because `RecordingPayload.recordingUrl` puts a
 * live media URL in a notification body, and the only thing keeping it away
 * from an operator is that `notifyRecordingAvailable` is called with
 * `getEventAttendeeIds(...)` — a participant list — rather than a roster.
 *
 * That is exactly the shape ADR 20 was written about: "the accident happened to
 * be mostly right... but it held only because no one had yet added a field to a
 * select statement". A future change widening that recipient list to
 * `rosterForOrg(orgId, VISIBILITY_ROLES)` would leak the URL with no test
 * failing, so these assertions pin the two halves of the rule:
 *
 *   1. Content-bearing payloads are only ever sent to participant-derived
 *      recipient lists.
 *   2. The org-roster dispatchers carry no content field at all.
 *
 * Source-level assertions for the same reason the sibling suite gives: what
 * matters is which recipient list each trigger reaches for.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const ORG_WORKFLOWS = "lib/novu/org-workflows.ts";
const WORKFLOWS = "lib/novu/workflows.ts";
const RECORDING_HANDLERS = "lib/stream/recording-handlers.ts";

/**
 * Fields ADR 20 names as session CONTENT. A payload carrying one of these may
 * only reach the two people who were in the session.
 */
const CONTENT_FIELDS = [
  "recordingUrl",
  "fileUrl",
  "storagePath",
  "requestNotes",
  "feedbackFromConsultee",
  "feedbackFromConsultant",
  "cancellationNotes",
  "transcript",
];

describe("ADR 20 — org-roster notifications carry no session content", () => {
  it("no org-roster payload type declares a content field", () => {
    const src = read(ORG_WORKFLOWS);
    // Everything in org-workflows.ts dispatches to rosterForOrg(), so no
    // payload defined or forwarded there may name a content field.
    for (const field of CONTENT_FIELDS) {
      expect(src).not.toContain(field);
    }
  });

  it("the roster resolver is the only recipient source in org-workflows", () => {
    const src = read(ORG_WORKFLOWS);
    // Guards against someone importing getEventAttendeeIds here and blurring
    // the two audiences into one file.
    expect(src).not.toContain("getEventAttendeeIds");
    expect(src).toContain("rosterForOrg");
  });

  it("recording notifications go to participants, never a roster", () => {
    const src = read(RECORDING_HANDLERS);

    // Asserting that `getEventAttendeeIds` merely APPEARS is too weak — it would
    // still pass if the notifier were handed a roster while the resolver sat
    // unused elsewhere in the file. So bind the two: take the identifier
    // actually passed as the recipient argument, and require THAT identifier to
    // be the one assigned from the attendee resolver.
    const call = /notifyRecordingAvailable\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(src);
    expect(call).not.toBeNull();
    const recipientVar = call![1];

    const assignedFromResolver = new RegExp(
      `(?:const|let|var)\\s+${recipientVar}\\s*=\\s*await\\s+getEventAttendeeIds\\(`,
    );
    expect(src).toMatch(assignedFromResolver);

    // And the roster resolvers must not be reachable from this file at all, so
    // the recipient list cannot be rebuilt from one further down.
    expect(src).not.toContain("rosterForOrg");
    expect(src).not.toContain("VISIBILITY_ROLES");
    expect(src).not.toContain("OPERATOR_ROLES");
  });

  it("RecordingPayload is still the only content-bearing shared payload", () => {
    const src = read(WORKFLOWS);
    // If a second payload grows a content field, this fails and whoever added
    // it has to come and think about who receives it.
    const carriers = CONTENT_FIELDS.filter((f) => src.includes(f));
    expect(carriers).toEqual(["recordingUrl"]);
  });
});

describe("ADR 23 — dual-context payloads are attributable", () => {
  const SCOPED_PAYLOADS = [
    "AppointmentPayload",
    "PaymentSuccessPayload",
    "BookingRequestPayload",
    "RecordingPayload",
  ];

  it.each(SCOPED_PAYLOADS)("%s composes NotificationScope", (name) => {
    const src = read(WORKFLOWS);
    expect(src).toContain(`export type ${name} = NotificationScope & {`);
  });

  it("notificationScope keeps scope and organizationId consistent", async () => {
    const { notificationScope } = await import("@/lib/novu/workflows");

    expect(notificationScope(null)).toEqual({
      organizationId: null,
      scope: "personal",
    });
    expect(notificationScope(undefined)).toEqual({
      organizationId: null,
      scope: "personal",
    });
    expect(notificationScope("org_1", "Acme")).toEqual({
      organizationId: "org_1",
      scope: "org",
      orgName: "Acme",
    });
    // A personal notification must not carry an org name — it would render an
    // attribution the scope contradicts.
    expect(notificationScope(null, "Acme")).toEqual({
      organizationId: null,
      scope: "personal",
    });
  });
});
