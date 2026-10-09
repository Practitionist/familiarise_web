/**
 * @jest-environment node
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingAssets: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({ withCronLock: jest.fn() }));

import {
  recordingRetentionDeadline,
  type RetentionInput,
} from "../../lib/stream/recording-retention";

const NOW = new Date("2027-06-01T00:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const plusDays = (iso: string, days: number) =>
  new Date(day(iso).getTime() + days * 24 * 60 * 60 * 1000);

const input = (overrides: Partial<RetentionInput>): RetentionInput => ({
  now: NOW,
  recordedAt: day("2027-01-01"),
  session: { kind: "CONSULTATION", sessionEndedAt: day("2027-01-01") },
  published: false,
  hasLivePurchase: false,
  orgRetentionDays: null,
  ...overrides,
});

describe("recordingRetentionDeadline", () => {
  it("keeps a 1:1 consultation for 90 days after the session", () => {
    expect(recordingRetentionDeadline(input({}))).toEqual(
      plusDays("2027-01-01", 90),
    );
  });

  it("keeps subscription and trial recordings until 90 days after the subscription ends", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: {
            kind: "SUBSCRIPTION",
            subscriptionEndsAt: day("2027-03-01"),
          },
        }),
      ),
    ).toEqual(plusDays("2027-03-01", 90));
  });

  it("has no deadline while the subscription is still active", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: {
            kind: "SUBSCRIPTION",
            subscriptionEndsAt: day("2027-09-01"),
          },
        }),
      ),
    ).toBeNull();
  });

  it("keeps a webinar for 365 days after the session", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: { kind: "WEBINAR", sessionEndedAt: day("2027-01-01") },
        }),
      ),
    ).toEqual(plusDays("2027-01-01", 365));
  });

  it("keeps a class for 365 days after its final session, with no deadline while sessions remain", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: { kind: "CLASS", lastSessionEndsAt: day("2027-02-01") },
        }),
      ),
    ).toEqual(plusDays("2027-02-01", 365));
    expect(
      recordingRetentionDeadline(
        input({
          session: { kind: "CLASS", lastSessionEndsAt: day("2027-07-01") },
        }),
      ),
    ).toBeNull();
  });

  it("caps at the org setting when it is shorter, and ignores it when longer", () => {
    expect(recordingRetentionDeadline(input({ orgRetentionDays: 30 }))).toEqual(
      plusDays("2027-01-01", 30),
    );
    expect(
      recordingRetentionDeadline(input({ orgRetentionDays: 400 })),
    ).toEqual(plusDays("2027-01-01", 90));
  });

  it("applies the org cap even while a subscription is active", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: {
            kind: "SUBSCRIPTION",
            subscriptionEndsAt: day("2027-09-01"),
          },
          orgRetentionDays: 60,
        }),
      ),
    ).toEqual(plusDays("2027-01-01", 60));
  });

  it("exempts published replays and live purchases, even under an org cap", () => {
    expect(
      recordingRetentionDeadline(
        input({ published: true, orgRetentionDays: 7 }),
      ),
    ).toBeNull();
    expect(
      recordingRetentionDeadline(
        input({ hasLivePurchase: true, orgRetentionDays: 7 }),
      ),
    ).toBeNull();
  });

  it("does not exempt a recording whose only purchases were refunded", () => {
    expect(
      recordingRetentionDeadline(input({ hasLivePurchase: false })),
    ).not.toBeNull();
  });

  it("uses only the platform schedule for personal recordings", () => {
    expect(
      recordingRetentionDeadline(
        input({
          orgRetentionDays: null,
          session: { kind: "WEBINAR", sessionEndedAt: day("2027-01-01") },
        }),
      ),
    ).toEqual(plusDays("2027-01-01", 365));
  });
});
