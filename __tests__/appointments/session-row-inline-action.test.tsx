// Invariant: a session row's first action shows at rest at every width, and an
// action that opens a page is a real link to it.

import * as React from "react";
import { render, screen } from "@testing-library/react";

import { InlineRowAction } from "@/components/appointments/detail/SessionSchedule";

it("renders a report entry as a link, visible at rest at every width", () => {
  render(
    <InlineRowAction
      action={{
        key: "report-occ-1",
        label: "Report a problem with this session",
        href: "/support/requests/b_apt-1?intent=NO_SHOW&occurrence=occ-1",
        onSelect: () => undefined,
      }}
    />,
  );
  const link = screen.getByRole("link", {
    name: "Report a problem with this session",
  });
  expect(link).toHaveAttribute(
    "href",
    "/support/requests/b_apt-1?intent=NO_SHOW&occurrence=occ-1",
  );
  // Hidden until hover or focus is invisible to a pointer user who never hovers the row.
  expect(link.className).not.toMatch(/opacity-0/);
});
