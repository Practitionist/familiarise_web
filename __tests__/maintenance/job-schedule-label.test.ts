/** @jest-environment node */

/**
 * System jobs show each schedule window in IST, with the catalog's UTC window
 * beside it for the hover; a window that opens after 18:30 UTC moves to the
 * next IST day.
 */

import { systemJobCards } from "@/lib/cron/job-catalog";

const card = (id: string) => {
  const found = systemJobCards().find((job) => job.id === id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
};

it("labels a daily window in IST with the UTC reading beside it", () => {
  expect(card("generate-subscription-invoices")).toMatchObject({
    schedule: "Hourly, 08:30–01:30 IST daily",
    scheduleUtc: "Hourly, 03:00–20:00 UTC daily",
  });
});

it("moves a late-UTC weekly window to the next IST weekday", () => {
  expect(card("create-payout-batch")).toMatchObject({
    schedule: "Every 15 minutes, 01:30–04:30 IST on Tuesdays",
    scheduleUtc: "Every 15 minutes, 20:00–23:00 UTC on Mondays",
  });
});

it("keeps a monthly window's day when IST is the same day", () => {
  expect(card("tds-return-draft")).toMatchObject({
    schedule: "Hourly, 06:30–08:30 IST on day 5 of months 1, 4, 7, 10",
    scheduleUtc: "Hourly, 01:00–03:00 UTC on day 5 of months 1, 4, 7, 10",
  });
});
