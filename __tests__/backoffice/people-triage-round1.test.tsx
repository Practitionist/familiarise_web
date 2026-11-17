/**
 * Review round 1 on the people screens: the review modal never carries one
 * applicant's audit reason to the next, a fee in bps is read whole, a pager
 * follows a list that shrank, the review card can shrink on a phone, and the
 * staff support times carry their UTC reading on hover.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import VerificationReviewModal from "@/components/admin/VerificationReviewModal";
import { parseWholeBps } from "@/components/dashboard/backoffice/fees/PlatformFeesPageClient";
import { usePageWithinTotal } from "@/components/dashboard/shared/paged-list-filters";
import { SupportBubble } from "@/components/support/SupportBubble";
import type { VerificationItem } from "@/lib/backoffice/people-list-schemas";
import { OPERATOR_ZONE } from "@/lib/time/operator-zone";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function applicant(id: string, name: string): VerificationItem {
  return {
    id,
    status: "PENDING",
    submittedAt: "2026-11-16T09:00:00.000Z",
    notes: null,
    consultant: {
      profileId: `cp-${id}`,
      userId: `u-${id}`,
      name,
      email: `${id}@example.test`,
      image: null,
      linkedinUrl: null,
      bio: null,
      domain: "Careers",
      subDomains: [],
      experience: 3,
      headline: null,
      description: null,
      isVerified: false,
      verificationStatus: "PENDING_VERIFICATION",
      workExperiences: [],
      education: [],
      certifications: [],
    },
    documents: [],
    reviewedAt: null,
    reviewedById: null,
    reviewNotes: null,
  };
}

it("clears the audit reason when the modal moves to another applicant", () => {
  const props = {
    open: true,
    onOpenChange: jest.fn(),
    onVerificationComplete: jest.fn(),
  };
  const { rerender } = render(
    <VerificationReviewModal
      verification={applicant("a", "Aarav Anderson")}
      {...props}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Reason for the audit log/), {
    target: { value: "ID and degree match" },
  });
  rerender(
    <VerificationReviewModal
      verification={applicant("b", "Aditi Anderson")}
      {...props}
    />,
  );
  expect(
    (screen.getByLabelText(/Reason for the audit log/) as HTMLTextAreaElement)
      .value,
  ).toBe("");
});

it.each([
  ["1500", 1500],
  ["0", 0],
  ["1e3", null],
  ["12.5", null],
  ["", null],
  ["5001", null],
  ["-1", null],
])("reads the fee %p as %p", (raw, expected) => {
  expect(parseWholeBps(raw)).toBe(expected);
});

it("moves a pager back to the last page when the list shrinks under it", () => {
  const setPage = jest.fn();
  const { rerender } = renderHook(
    ({ total }) => usePageWithinTotal(2, setPage, total, 20),
    { initialProps: { total: 21 } },
  );
  expect(setPage).not.toHaveBeenCalled();
  rerender({ total: 20 });
  expect(setPage).toHaveBeenCalledWith(1);
  setPage.mockClear();
  rerender({ total: 0 });
  expect(setPage).toHaveBeenCalledWith(1);
});

it("lets a moderation review card's text column shrink below its content on a phone", () => {
  const src = read("components/dashboard/shared/ModerationPage.tsx");
  const card = src.slice(src.indexOf("{reviews.map((review) => {"));
  expect(card).toContain('<div className="flex min-w-0 items-start gap-3">');
  expect(card).toContain('<div className="min-w-0 flex-1">');
  expect(card).toContain(
    '<div className="flex min-w-0 flex-wrap items-center gap-2">',
  );
});

it("a staff chat time reads IST with its UTC reading on hover", () => {
  render(
    <DisplayZoneProvider zone={OPERATOR_ZONE}>
      <SupportBubble
        author="AGENT"
        body="Refund sent"
        at="2026-11-16T12:45:00.000Z"
        perspective="staff"
      />
    </DisplayZoneProvider>,
  );
  const time = screen.getByText(/6:15\s?pm IST/i);
  expect(time.getAttribute("title")).toMatch(/12:45\s?pm UTC/i);
});

it.each([
  "components/dashboard/backoffice/support/CaseWorkspace.tsx",
  "components/dashboard/backoffice/support/CaseDetails.tsx",
  "components/dashboard/backoffice/support/CaseChatPanel.tsx",
  "components/dashboard/backoffice/support/CaseChatTranscript.tsx",
  "components/dashboard/backoffice/support/CaseChatIntervention.tsx",
  "components/support/resolution/StaffCaseResolution.tsx",
  "components/support/resolution/FinancialPanel.tsx",
])("%s prints exact instants through OperatorTime", (file) => {
  const src = read(file);
  expect(src).toContain("<OperatorTime");
  expect(src).not.toContain("formatOperatorInstant(");
});

it("keeps a pager mounted when a moderation or announcement page empties", () => {
  for (const file of [
    "components/dashboard/shared/ModerationPage.tsx",
    "components/dashboard/shared/AnnouncementsPage.tsx",
    "components/dashboard/backoffice/organizations/OrgVerificationQueue.tsx",
  ]) {
    expect(read(file)).toContain("usePageWithinTotal(");
  }
  act(() => undefined);
});
