/**
 * Record-id segments, including unscheduled class/webinar synthetic ids, are
 * named by the page's override label; ordinary slugs keep their page label.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  BreadcrumbOverrideProvider,
  useSetBreadcrumbLabel,
} from "@/components/dashboard/breadcrumb-override";
import { useDashboardBreadcrumbs } from "@/components/dashboard/breadcrumbs";

const mockParams: Record<string, string> = {};
jest.mock("next/navigation", () => ({
  useParams: () => mockParams,
}));

const CONSULTANT_ID = "cmconsultant0000000000001";
const BASE = `/dashboard/consultant/${CONSULTANT_ID}`;
const pageLabels = { appointments: "Appointments", timings: "Timings" };

function wrapper({ children }: { children: ReactNode }) {
  return <BreadcrumbOverrideProvider>{children}</BreadcrumbOverrideProvider>;
}

function crumbsFor(pathname: string, label: string | null) {
  const { result } = renderHook(
    () => {
      useSetBreadcrumbLabel(label);
      return useDashboardBreadcrumbs({ pathname, basePath: BASE, pageLabels });
    },
    { wrapper },
  );
  return result.current;
}

describe("useDashboardBreadcrumbs record ids", () => {
  afterEach(() => {
    for (const key of Object.keys(mockParams)) delete mockParams[key];
  });

  it.each([
    ["class", "unscheduled-class-cmu15sqkc03izc7yofrqdqr7n"],
    ["webinar", "unscheduled-webinar-cmu15sqkc03izc7yofrqdqr7n"],
  ])(
    "names an unscheduled %s crumb by the page title",
    (_kind, appointmentId) => {
      mockParams.consultantId = CONSULTANT_ID;
      mockParams.appointmentId = appointmentId;
      const crumbs = crumbsFor(
        `${BASE}/appointments/${appointmentId}/timings`,
        "Morning Yoga",
      );
      expect(crumbs).toEqual([
        { label: "Appointments", href: `${BASE}/appointments` },
        {
          label: "Morning Yoga",
          href: `${BASE}/appointments/${appointmentId}`,
        },
        { label: "Timings" },
      ]);
    },
  );

  it("drops an unscheduled id crumb when the page sets no label", () => {
    const appointmentId = "unscheduled-class-cmu15sqkc03izc7yofrqdqr7n";
    mockParams.appointmentId = appointmentId;
    const crumbs = crumbsFor(
      `${BASE}/appointments/${appointmentId}/timings`,
      null,
    );
    expect(crumbs.map((c) => c.label)).toEqual(["Appointments", "Timings"]);
  });

  it.each(["unscheduled-classes", "unscheduled-class-intro", "unscheduled"])(
    "keeps the ordinary slug %s as a prettified crumb",
    (slug) => {
      const crumbs = crumbsFor(`${BASE}/appointments/${slug}`, "Ignored");
      expect(crumbs[1]?.label).not.toBe("Ignored");
      expect(crumbs).toHaveLength(2);
    },
  );
});

describe("useDashboardBreadcrumbs list homes", () => {
  it("points a list crumb at the page that holds the list", () => {
    const OPS = "/dashboard/admin";
    mockParams.tree = "admin";
    mockParams.paymentId = "26014b76-1d2a-4f3b-9c4d-5e6f7a8b9c0d";
    const { result } = renderHook(
      () =>
        useDashboardBreadcrumbs({
          pathname: `${OPS}/payments/26014b76-1d2a-4f3b-9c4d-5e6f7a8b9c0d`,
          basePath: OPS,
          pageLabels: { payments: "Payments" },
          listHrefs: { payments: "money/payments" },
        }),
      { wrapper },
    );
    expect(result.current[0]).toEqual({
      label: "Payments",
      href: `${OPS}/money/payments`,
    });
  });
});
