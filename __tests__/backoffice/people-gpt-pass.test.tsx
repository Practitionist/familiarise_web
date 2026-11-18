/**
 * Owner review pass: the verification queue and the SSO approvals never echo
 * a page that emptied under the operator; each moves back to its last page.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
const mockSso = { findMany: jest.fn(), count: jest.fn() };
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    ssoProvider: {
      findMany: (...a: unknown[]) => mockSso.findMany(...a),
      count: (...a: unknown[]) => mockSso.count(...a),
    },
  },
}));
jest.mock("@/lib/payments/wallet-freeze", () => ({
  isWalletFrozen: jest.fn(),
}));

import { VerificationQueue } from "@/components/admin/VerificationQueue";
import { readPendingSsoApprovals } from "@/lib/backoffice/org-detail";

const reply = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function applicant(n: number) {
  return {
    id: `v-${n}`,
    status: "PENDING",
    submittedAt: "2026-11-16T09:00:00.000Z",
    notes: null,
    consultant: {
      profileId: `cp-${n}`,
      userId: `u-${n}`,
      name: `Applicant ${n}`,
      email: `a${n}@example.test`,
      image: null,
      linkedinUrl: null,
      bio: null,
      domain: "Careers",
      subDomains: [],
      experience: 2,
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

it("moves the verification queue back a page when its last applicant is decided", async () => {
  let pending = Array.from({ length: 21 }, (_, i) => i + 1);
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test");
    const page = Number(url.searchParams.get("page"));
    const rows = pending.slice((page - 1) * 20, page * 20).map(applicant);
    const total = pending.length;
    return reply({
      verifications: rows,
      counts: { total, pending: total, approved: 0, rejected: 0, needsInfo: 0 },
      pagination: {
        total,
        page,
        limit: 20,
        totalPages: Math.ceil(total / 20),
        hasMore: page * 20 < total,
      },
    });
  }) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<VerificationQueue />, { wrapper });
  expect(await screen.findByText("1–20 of 21")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  expect(await screen.findByText("Applicant 21")).toBeTruthy();

  // Another operator approves applicant 21; this queue refetches.
  pending = pending.filter((n) => n !== 21);
  fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

  expect(await screen.findByText("1–20 of 20")).toBeTruthy();
  expect(screen.queryByText("21–20 of 20")).toBeNull();
});

it("returns the last page of SSO approvals when the asked page emptied, in two statements", async () => {
  mockSso.count.mockResolvedValue(20);
  mockSso.findMany.mockResolvedValue([]);
  const result = await readPendingSsoApprovals(2);
  expect(result).toMatchObject({ page: 1, total: 20, pageSize: 20 });
  expect(mockSso.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      skip: 0,
      take: 20,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
  expect(mockSso.count).toHaveBeenCalledTimes(1);
  expect(mockSso.findMany).toHaveBeenCalledTimes(1);
});

it("re-reads the clamped page once when an approval empties the asked page between count and read", async () => {
  const row = {
    providerId: "sso-1",
    issuer: "https://idp.example",
    domain: "example.test",
    createdAt: new Date("2026-11-16T09:00:00Z"),
    organization: { id: "org-1", name: "Acme" },
  };
  // 21 pending when counted, then one is approved before the page-2 read.
  mockSso.count.mockResolvedValueOnce(21).mockResolvedValueOnce(20);
  mockSso.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
  const result = await readPendingSsoApprovals(2);
  expect(result).toMatchObject({ page: 1, total: 20 });
  expect(result.rows).toHaveLength(1);
  expect(mockSso.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ skip: 0 }),
  );
  expect(mockSso.count).toHaveBeenCalledTimes(2);
  expect(mockSso.findMany).toHaveBeenCalledTimes(2);
});

it("reads page 1 of an empty SSO queue", async () => {
  mockSso.count.mockResolvedValue(0);
  mockSso.findMany.mockResolvedValue([]);
  await expect(readPendingSsoApprovals(5)).resolves.toMatchObject({
    page: 1,
    total: 0,
    rows: [],
  });
});
