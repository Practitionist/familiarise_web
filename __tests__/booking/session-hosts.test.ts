/**
 * @jest-environment node
 */

// Invariant: a past session's host side is the plan's owner plus every
// collaborator whose accepted period overlaps the booked window. The viewer
// gate alone reads today's roster.

import {
  currentSessionHostUserIds,
  SESSION_HOSTS_SELECT,
  sessionHostUserIds,
  type SessionHostsRow,
} from "@/lib/booking/session-hosts";

const START = new Date("2026-11-20T10:00:00Z");
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);
const WINDOW = { startsAt: at(0), endsAt: at(60) };

type Period = SessionHostsRow["class"] extends infer C
  ? C extends { classPlan: { collaborators: (infer P)[] } }
    ? P
    : never
  : never;

const period = (
  userId: string,
  acceptedAt: Date,
  endedAt: Date | null,
  deletedAt: Date | null = null,
): Period => ({
  status: endedAt ? "REMOVED" : "ACCEPTED",
  acceptedAt,
  endedAt,
  consultantProfile: { userId, deletedAt },
});

const classRow = (collaborators: Period[]): SessionHostsRow => ({
  consultation: null,
  subscription: null,
  trial: null,
  webinar: null,
  class: {
    classPlan: { consultantProfile: { userId: "owner" }, collaborators },
  },
});

it("reads every accepted period, not today's roster or a live profile", () => {
  const { where } =
    SESSION_HOSTS_SELECT.class.select.classPlan.select.collaborators;
  expect(where).toEqual({ acceptedAt: { not: null } });
});

it("counts a collaborator on the team during the session, whatever happened to them since", () => {
  const row = classRow([
    period("removed-after", at(-600), at(120)),
    period("erased-after", at(-600), at(120), at(180)),
    period("left-mid-session", at(-600), at(20)),
    period("joined-mid-session", at(40), null),
    period("left-before", at(-600), at(0)),
    period("joined-after", at(60), null),
  ]);
  expect(sessionHostUserIds(row, WINDOW).sort()).toEqual([
    "erased-after",
    "joined-mid-session",
    "left-mid-session",
    "owner",
    "removed-after",
  ]);
});

it("keeps the viewer gate on today's roster: accepted now, profile not erased", () => {
  const row = classRow([
    period("removed-after", at(-600), at(120)),
    period("joined-after", at(60), null),
    period("erased", at(-600), null, at(180)),
  ]);
  expect(currentSessionHostUserIds(row).sort()).toEqual([
    "joined-after",
    "owner",
  ]);
});
