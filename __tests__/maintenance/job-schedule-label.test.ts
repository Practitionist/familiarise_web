/** @jest-environment node */

/**
 * System jobs show each schedule window in IST, with the catalog's UTC window
 * beside it for the hover. An end on the next day says so, a 24-hour window
 * reads "all day", and a window opening after 18:30 UTC moves its start to
 * the next IST day.
 */

import { systemJobCards } from "@/lib/cron/job-catalog";

const card = (id: string) => {
  const found = systemJobCards().find((job) => job.id === id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
};

it("marks a daily window that ends after IST midnight", () => {
  expect(card("generate-subscription-invoices")).toMatchObject({
    schedule: "Hourly, 08:30 IST to 01:30 IST the next day, daily",
    scheduleUtc: "Hourly, 03:00 UTC to 20:00 UTC, daily",
  });
});

it("reads a 24-hour window as all day", () => {
  expect(card("heal-consumer-invoices")).toMatchObject({
    schedule: "Every 6 hours, all day, daily",
    scheduleUtc: "Every 6 hours, all day, daily",
  });
});

it("keeps a monthly window's start day and marks the next-day end", () => {
  expect(card("settle-invoice-accruals")).toMatchObject({
    schedule:
      "Hourly, 09:30 IST to 01:30 IST the next day, on day 1 of each month",
    scheduleUtc: "Hourly, 04:00 UTC to 20:00 UTC, on day 1 of each month",
  });
  expect(card("tds-return-draft")).toMatchObject({
    schedule: "Hourly, 06:30 IST to 08:30 IST, on day 5 of months 1, 4, 7, 10",
  });
});

it("moves a late-UTC weekly window to the next IST weekday", () => {
  expect(card("create-payout-batch")).toMatchObject({
    schedule: "Every 15 minutes, 01:30 IST to 04:30 IST, on Tuesdays",
    scheduleUtc: "Every 15 minutes, 20:00 UTC to 23:00 UTC, on Mondays",
  });
});

it("marks a UTC window that crosses UTC midnight in the title too", () => {
  expect(card("dunning")).toMatchObject({
    schedule: "Hourly, 05:00 IST to 08:00 IST, daily",
    scheduleUtc: "Hourly, 23:30 UTC to 02:30 UTC the next day, daily",
  });
});
