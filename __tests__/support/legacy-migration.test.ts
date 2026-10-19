/** @jest-environment node */
import {
  migrationOptions,
  planLegacySupportCase,
} from "../../scripts/db/migrate-support-cases";
const createdAt = new Date("2026-10-01T10:00:00Z");
const updatedAt = new Date("2026-10-02T10:00:00Z");
const thread = {
  id: "old-thread",
  userId: "customer",
  appointmentId: "appointment",
  category: "OTHER",
  status: "CLOSED",
  activeChannel: "HUMAN",
  createdAt,
  updatedAt,
};
it("never falls back to the shared application database", () => {
  expect(() =>
    migrationOptions([], {
      DATABASE_URL: "postgres://user:secret@shared.invalid/app",
    }),
  ).toThrow();
});
it("is read-only by default and requires an exact host acknowledgement to apply", () => {
  const env = {
    SUPPORT_MIGRATION_DATABASE_URL:
      "postgres://user:secret@localhost:5432/rehearsal",
  };
  expect(migrationOptions([], env)).toMatchObject({
    apply: false,
    batchSize: 50,
    maxSources: 1000,
    target: { host: "localhost:5432", database: "rehearsal" },
  });
  expect(() =>
    migrationOptions(["--apply", "--ack-host=shared.invalid"], env),
  ).toThrow();
  expect(
    migrationOptions(["--apply", "--ack-host=localhost:5432"], env).apply,
  ).toBe(true);
});
it("normalizes a closed legacy conversation and retains aliases, original evidence time and sequence", () => {
  const plan = planLegacySupportCase({
    ticket: null,
    thread,
    messages: [
      { id: "m2", sender: "BOT", body: "Second", seq: 2, createdAt },
      { id: "m1", sender: "USER", body: "First", seq: 1, createdAt },
    ],
  });
  expect(plan.supportCase).toMatchObject({
    closedAt: updatedAt,
    requesterUserId: "customer",
    scopeKey: "APPOINTMENT:appointment",
    messageSeq: 2,
  });
  expect(plan.messages.map((message) => [message.seq, message.body])).toEqual([
    [1, "First"],
    [2, "Second"],
  ]);
  expect(plan.aliases).toEqual([
    expect.objectContaining({ legacyKind: "thread", legacyId: "old-thread" }),
  ]);
  expect(plan.supportCase.createdAt).toEqual(createdAt);
});
it("rejects a ticket/thread ownership mismatch instead of merging correspondence", () => {
  const ticket = {
    id: "ticket",
    userId: "other-user",
    title: "Help",
    description: "Private",
    priority: "MEDIUM",
    status: "OPEN",
    createdAt,
    updatedAt,
  };
  expect(() =>
    planLegacySupportCase({
      ticket,
      thread: { ...thread, supportTicketId: "ticket" },
    }),
  ).toThrow("LINK_OWNERSHIP_MISMATCH");
});
