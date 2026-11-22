/**
 * @jest-environment node
 */

// The lifecycle email states the terms on an accept to both sides, reads a
// withdrawn invitation and an ended place on the team differently, claims no
// access or money fact, and tells a seat holder only that the co-host changed.

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CollaborationLifecycleEmail, {
  cohostChangeSentence,
  type CollaborationEmailEvent,
  type CollaborationLifecycleEmailProps,
} from "@/emails/collaborations/CollaborationLifecycleEmail";
import { ROLE_INFO } from "@/lib/collaborators/roles";

const EVENTS: CollaborationEmailEvent[] = [
  "INVITED",
  "TERMS_CHANGED",
  "ACCEPTED",
  "DECLINED",
  "REMOVED",
  "WITHDRAWN",
  "EXPIRED",
  "EXPIRING_SOON",
  "COHOST_JOINED",
  "COHOST_LEFT",
];

function text(over: Partial<CollaborationLifecycleEmailProps>): string {
  return renderToStaticMarkup(
    <CollaborationLifecycleEmail
      event="ACCEPTED"
      collaboratorName="Ravi"
      planTitle="Systems"
      planKindLabel="Webinar"
      roleLabel={ROLE_INFO.CO_HOST.label}
      roleCan={ROLE_INFO.CO_HOST.can}
      revenueSharePct={25}
      dashboardUrl="https://app.test/dashboard"
      {...over}
    />,
  )
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

it.each([true, false])(
  "an accept carries the role, what it may do, the share and a rupee example (to the collaborator: %s)",
  (toCollaborator) => {
    const out = text({ event: "ACCEPTED", toCollaborator });
    expect(out).toContain("Co-host");
    for (const line of ROLE_INFO.CO_HOST.can) expect(out).toContain(line);
    expect(out).toContain("25% of each seat");
    expect(out).toContain("of a seat sold for ₹1,000, ₹250 is");
    expect(out).toContain(toCollaborator ? "your share" : "their share");
    expect(out).toContain("before the platform fee");
  },
);

it("a withdrawn invitation is not a removal from a team, and each names whoever did it", () => {
  const invite = text({
    event: "REMOVED",
    pendingInvite: true,
    actorName: "Asha",
  });
  expect(invite).toContain("Your invitation to Systems was withdrawn");
  expect(invite).toContain("was withdrawn by Asha");
  expect(invite).not.toContain("team");

  const place = text({ event: "REMOVED", actorName: "Asha" });
  expect(place).toContain("was ended by Asha");
  expect(place).toContain("no longer on this plan's team");
  expect(text({ event: "REMOVED" })).not.toContain(" by ");
});

it("no event claims an access, earnings or refund fact", () => {
  for (const event of EVENTS) {
    expect({ event, out: text({ event }) }).toEqual({
      event,
      out: expect.not.stringMatching(
        /revoked|now active|settled|earnings|refund|owner pool/i,
      ),
    });
  }
});

it("an invitation and its reminder give the day it lapses, and only the reminder can be switched off", () => {
  const expiresOn = "Sat, 21 Nov 2026 at 9:00 AM IST";
  expect(text({ event: "INVITED", actorName: "Asha", expiresOn })).toContain(
    `accept or decline by ${expiresOn}`,
  );
  const reminder = text({
    event: "EXPIRING_SOON",
    expiresOn,
    unsubscribeUrl: "https://app.test/unsubscribe",
  });
  expect(reminder).toContain(`lapses on ${expiresOn}`);
  expect(reminder).not.toContain("cannot be turned off");
  expect(text({ event: "INVITED" })).toContain("cannot be turned off");
});

it.each(["COHOST_JOINED", "COHOST_LEFT"] as const)(
  "%s tells a seat holder the one sentence and nothing about terms",
  (event) => {
    const out = text({ event, roleLabel: "", revenueSharePct: undefined });
    expect(out).toContain(cohostChangeSentence(event, "Ravi", "Systems"));
    expect(out).not.toMatch(/share|Role:/);
  },
);
