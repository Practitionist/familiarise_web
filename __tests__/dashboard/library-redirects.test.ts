/**
 * @jest-environment node
 */

/**
 * Every route the Library absorbed answers a 308 to its tab with the old
 * query kept, and `/dashboard/go/library` forwards `?tab=` to the viewer's own.
 */

const mockPermanentRedirect = jest.fn((path: string) => {
  throw new Error(`NEXT_PERMANENT_REDIRECT:${path}`);
});
const mockRedirect = jest.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});

jest.mock("next/navigation", () => ({
  __esModule: true,
  permanentRedirect: (path: string) => mockPermanentRedirect(path),
  redirect: (path: string) => mockRedirect(path),
  notFound: jest.fn(),
}));
jest.mock("../../lib/auth-guard", () => ({
  requireOnboarded: async () => ({
    user: {
      role: "CONSULTANT",
      consultantProfileId: "cp-1",
      consulteeProfileId: "ce-1",
      orgWorkspaceProfileId: null,
      organizationMemberships: [],
    },
  }),
}));
jest.mock("../../lib/data/appointment-detail", () => ({
  appointmentViewerSides: jest.fn(),
  readAppointmentDetail: jest.fn(),
}));

import ConsulteeDocuments from "../../app/dashboard/consultee/[consulteeId]/(features)/documents/page";
import ConsulteeRecordings from "../../app/dashboard/consultee/[consulteeId]/(features)/recordings/page";
import ConsulteeProducts from "../../app/dashboard/consultee/[consulteeId]/(features)/products/page";
import ConsultantPurchases from "../../app/dashboard/consultant/[consultantId]/(features)/purchases/page";
import OrgDocuments from "../../app/dashboard/organization/[orgId]/documents/page";
import OrgRecordings from "../../app/dashboard/organization/[orgId]/recordings/page";
import GoPage from "../../app/dashboard/go/[facet]/[[...path]]/page";

type SearchParams = Record<string, string | string[] | undefined>;
type RedirectPage = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<SearchParams>;
}) => Promise<unknown>;

const ce = "/dashboard/consultee/ce-1";
const cp = "/dashboard/consultant/cp-1";
const org = "/dashboard/organization/org-1";
const params = { consulteeId: "ce-1", consultantId: "cp-1", orgId: "org-1" };

describe("moved Library routes 308 with their query", () => {
  it.each<[string, RedirectPage, string]>([
    [
      "consultee documents",
      ConsulteeDocuments,
      `${ce}/library?q=cv&tab=documents`,
    ],
    [
      "consultee recordings",
      ConsulteeRecordings,
      `${ce}/library?q=cv&tab=recordings`,
    ],
    [
      "consultee products",
      ConsulteeProducts,
      `${ce}/library?q=cv&tab=purchases`,
    ],
    ["consultant purchases", ConsultantPurchases, `${cp}/library?q=cv`],
    ["org documents", OrgDocuments, `${org}/library?q=cv&tab=documents`],
    ["org recordings", OrgRecordings, `${org}/library?q=cv&tab=recordings`],
  ])("%s", async (_name, Page, target) => {
    await expect(
      Page({
        params: Promise.resolve(params),
        // A stale `tab` never survives the move.
        searchParams: Promise.resolve({ q: "cv", tab: "old" }),
      }),
    ).rejects.toThrow("NEXT_PERMANENT_REDIRECT");
    expect(mockPermanentRedirect).toHaveBeenLastCalledWith(target);
  });
});

it("go/library lands a dual-profile viewer on the learner Library tab", async () => {
  await expect(
    GoPage({
      params: Promise.resolve({ facet: "library" }),
      searchParams: Promise.resolve({ tab: "purchases" }),
    }),
  ).rejects.toThrow("NEXT_REDIRECT");
  expect(mockRedirect).toHaveBeenLastCalledWith(`${ce}/library?tab=purchases`);
});
