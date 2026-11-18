/** @jest-environment node */

// The back-office collaborations list names each person with their email and
// links them to their back-office page; the earnings door opens on that
// expert's rows; times are India time. Nothing on the page is an id to copy.

const mockRequire = jest.fn();
jest.mock("@/lib/auth-guard", () => ({
  requireBackofficePage: (...args: unknown[]) => mockRequire(...args),
}));
const mockRead = jest.fn();
jest.mock("@/lib/backoffice/collaborations-read", () => ({
  COLLABORATIONS_PAGE_SIZE: 50,
  readCollaborations: (...args: unknown[]) => mockRead(...args),
}));

import { renderToStaticMarkup } from "react-dom/server";

import BackofficeCollaborationsPage from "@/app/dashboard/(backoffice)/[tree]/collaborations/page";
import type { BackofficeCollaboration } from "@/lib/backoffice/collaborations-read";
import { resolveBackofficeCapability } from "@/lib/backoffice/capability";

const row = (
  over: Partial<BackofficeCollaboration>,
): BackofficeCollaboration => ({
  id: "c-1",
  planType: "webinar",
  planId: "wp-1",
  planTitle: "Systems",
  organizationName: null,
  expert: { id: "u-ravi", name: "Ravi", email: "ravi@example.com" },
  consultantProfileId: "cp-ravi",
  roleLabel: "Co-host",
  sharePercent: 25,
  status: "ACCEPTED",
  acceptedAt: new Date("2026-11-01T10:00:00Z"),
  endedAt: null,
  endedBy: null,
  ...over,
});

const ROWS = [
  row({}),
  row({
    id: "c-2",
    status: "REMOVED",
    endedAt: new Date("2026-11-09T10:00:00Z"),
    endedBy: { id: "u-asha", name: "Asha", email: "asha@example.com" },
  }),
  row({
    id: "c-3",
    status: "EXPIRED",
    acceptedAt: null,
    endedAt: new Date("2026-11-10T10:00:00Z"),
  }),
];

async function page(role: "ADMIN" | "STAFF") {
  const tree = role === "ADMIN" ? "admin" : "staff";
  mockRequire.mockResolvedValue({
    cap: resolveBackofficeCapability(role, tree),
  });
  mockRead.mockResolvedValue({ rows: ROWS, total: ROWS.length, page: 1 });
  return renderToStaticMarkup(
    await BackofficeCollaborationsPage({
      params: Promise.resolve({ tree }),
      searchParams: Promise.resolve({}),
    }),
  );
}

it("names the expert and whoever ended a collaboration, each linked to their back-office page, with no id in the text", async () => {
  const html = await page("ADMIN");

  expect(mockRequire).toHaveBeenCalledWith("payouts.read", "admin");
  expect(html).toContain("Ravi");
  expect(html).toContain("ravi@example.com");
  expect(html).toContain('href="/dashboard/admin/users/u-ravi"');
  expect(html).toContain("Asha");
  expect(html).toContain('href="/dashboard/admin/users/u-asha"');
  // An id appears only inside a link's address, never as text to copy.
  expect(html).not.toMatch(/>\s*(u-ravi|u-asha|cp-ravi)\s*</);
  // Ended with nobody named: the platform; not ended: a dash.
  expect(html).toContain("The platform");
  expect(html).toContain("IST");
});

it("opens the earnings door on the expert's own rows, for an operator who may hold earnings only", async () => {
  expect(await page("ADMIN")).toContain(
    'href="/dashboard/admin/money/earnings?consultantProfileId=cp-ravi"',
  );
  const staff = await page("STAFF");
  expect(staff).not.toContain("money/earnings");
  expect(staff).toContain('href="/dashboard/staff/users/u-ravi"');
});
