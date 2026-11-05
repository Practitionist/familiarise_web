/** @jest-environment node */
import {
  providerWindowRefusal,
  PROVIDER_WINDOW_EXPIRED,
  PROVIDER_TIMESTAMP_INVALID,
} from "@/lib/retry/provider-window";
import { emailReplayRefusal } from "@/lib/email/replay-policy";
const now = new Date("2026-11-06T00:00:00Z");
const recent = new Date("2026-11-05T23:00:00Z");
const old = new Date("2026-11-04T23:00:00Z");
const row = {
  status: "DEAD_LETTER",
  emailType: "PAYMENT_SUCCESS",
  createdAt: recent,
  lastError: "provider unavailable",
  resendId: null,
  sentAt: null,
};
it("allows the same immutable key inside the documented provider window", () => {
  expect(providerWindowRefusal(recent, now)).toBeNull();
  expect(emailReplayRefusal(row, now)).toBeNull();
});
it("requires acceptance review at the boundary and beyond, without claiming an old unsent row was delivered", () => {
  expect(providerWindowRefusal(new Date("2026-11-05T00:00:00Z"), now)).toBe(
    PROVIDER_WINDOW_EXPIRED,
  );
  expect(providerWindowRefusal(old, now)).toBe(PROVIDER_WINDOW_EXPIRED);
  expect(emailReplayRefusal({ ...row, createdAt: old }, now)).toBe(
    "provider_review",
  );
});
it("keeps a future publication's first eligible time distinct from its creation date", () => {
  expect(providerWindowRefusal(old, now, recent)).toBeNull();
});
it("refuses missing or malformed durable timing", () => {
  expect(providerWindowRefusal(undefined, now)).toBe(
    PROVIDER_TIMESTAMP_INVALID,
  );
  expect(providerWindowRefusal("invalid", now)).toBe(
    PROVIDER_TIMESTAMP_INVALID,
  );
});
it.each([
  ["credential", { emailType: "PASSWORD_RESET" }],
  ["pre_launch_hold", { lastError: "held:pre-launch" }],
  ["already_accepted", { resendId: "provider-receipt" }],
  ["recipient_policy", { lastError: "policy:preferences" }],
  ["recipient_policy", { lastError: "suppressed:COMPLAINT" }],
  ["not_dead_letter", { status: "SENT" }],
])("keeps %s messages outside generic replay", (reason, changes) => {
  expect(emailReplayRefusal({ ...row, ...changes }, now)).toBe(reason);
});
