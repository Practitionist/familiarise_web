/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingCalendarLoadingGrid } from "@/components/booking/BookingCalendarLoadingGrid";

it.each<[Date, number]>([
  [new Date(2026, 11, 1), 35],
  [new Date(2026, 7, 1), 42],
  [new Date(2027, 1, 1), 28],
])(
  "matches the month grid height without showing dates or interactive cells",
  (month, cells) => {
    const html = renderToStaticMarkup(
      <BookingCalendarLoadingGrid month={month} />,
    );
    expect(html.match(/class="[^"]*h-10 /g)).toHaveLength(cells);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/>\d+</);
  },
);
