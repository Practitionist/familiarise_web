/**
 * Review round 1 on the people screens: the review modal never carries one
 * applicant's audit reason to the next, a fee in bps is read whole, a pager
 * follows a list that shrank, the review card can shrink on a phone, and the
 * staff support times carry their UTC reading on hover.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import VerificationReviewModal from "@/components/admin/VerificationReviewModal";
import {
  makerOrSystem,
  parseWholeBps,
} from "@/components/dashboard/backoffice/fees/PlatformFeesPageClient";
import { OperatorTime } from "@/lib/time/operator-time";
import { usePageWithinTotal } from "@/components/dashboard/shared/paged-list-filters";
import { SupportBubble } from "@/components/support/SupportBubble";
import type { VerificationItem } from "@/lib/backoffice/people-list-schemas";
import { OPERATOR_ZONE } from "@/lib/time/operator-zone";
import { opsReasonSchema } from "@/lib/backoffice/ops-reason";
import { ReviewVerificationSchema } from "@/schemas/verifications";
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

it("keeps the decision buttons off until the audit reason is long enough, and Reject until the applicant's reason is given", async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ message: "ok" }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  render(
    <VerificationReviewModal
      verification={applicant("a", "Aarav Anderson")}
      open
      onOpenChange={jest.fn()}
      onVerificationComplete={jest.fn()}
    />,
  );
  const button = (name: RegExp) => screen.getByRole("button", { name });
  expect(button(/^Approve$/)).toBeDisabled();
  expect(button(/^Reject$/)).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Reason for the audit log/), {
    target: { value: "ID does not match" },
  });
  expect(button(/^Approve$/)).toBeEnabled();
  expect(button(/^Reject$/)).toBeDisabled();
  expect(button(/Request Changes/)).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Brief Reason/), {
    target: { value: "The ID photo is unreadable." },
  });
  expect(button(/^Reject$/)).toBeEnabled();
  fireEvent.click(button(/^Reject$/));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(
    ReviewVerificationSchema.extend({ reason: opsReasonSchema }).parse(sent),
  ).toMatchObject({
    status: "REJECTED",
    rejectionReason: "The ID photo is unreadable.",
  });
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

it("a moderation review card names the reviewer, never their profile id", () => {
  const src = read("components/dashboard/shared/ModerationPage.tsx");
  const card = src.slice(src.indexOf("{reviews.map((review) => {"));
  expect(card).not.toContain("id: review.reviewer.profileId");
  expect(card).toContain("name: review.reviewer.name");
});

it("keeps a moderation review's date on one line, whichever card it is on", () => {
  const src = read("components/dashboard/shared/ModerationPage.tsx");
  const card = src.slice(src.indexOf("{reviews.map((review) => {"));
  expect(card).toMatch(
    /<span className="[^"]*whitespace-nowrap[^"]*">\s*\{formatDate\(review\.createdAt\)\}/,
  );
});

it("names a fee schedule written by no user System, never Removed user", () => {
  expect(makerOrSystem({ id: "system-seed", name: null, email: null })).toEqual(
    {
      id: "system-seed",
      name: "System",
      email: null,
    },
  );
  const person = { id: "u-1", name: "Maria Brown", email: "m@example.test" };
  expect(makerOrSystem(person)).toBe(person);
});

it("a date-only operator cell says its day is the IST day on hover", () => {
  render(<OperatorTime value="2026-10-23T22:23:00Z" kind="date" />);
  const cell = screen.getByText("24 Oct 2026");
  expect(cell.getAttribute("title")).toMatch(/^IST day · /);
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
