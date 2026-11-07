/**
 * @jest-environment node
 */

/**
 * #1527 QA wave 4 — one pin per backoffice defect. Most are source-text
 * checks: each failure was structural (a control placed under a fixed
 * overlay, a row with no handler, a name read from the wrong user, a
 * runtime-zone formatter), and a render harness per surface would cost far
 * more than it catches.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { runConfirmPhrase } from "@/lib/cron/job-catalog";
import type { JobCategory } from "@/lib/cron/job-categories";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("QA wave 4 (backoffice)", () => {
  it("B13 — the newsletter send form sits above the list and keeps its count", () => {
    const src = read("components/admin/NewsletterManagement.tsx");
    expect(src.indexOf("Send a newsletter")).toBeGreaterThan(-1);
    expect(src.indexOf("Send a newsletter")).toBeLessThan(
      src.indexOf("{renderSubscriberTable()}"),
    );
    expect(src).toContain("placeholderData: keepPreviousData");
  });

  it("B5 — every Awaiting-payment row opens something", () => {
    const src = read("components/dashboard/shared/AwaitingPaymentPanel.tsx");
    expect(src).toMatch(
      /onRowClick=\{\(p\) =>\s*p\.appointmentId \? onOpenBooking\(p\.appointmentId\) : setRequest\(p\)/,
    );
  });

  it("B6 — the operator banner names the route profile's owner", () => {
    const core = read("components/dashboard/PersonalDashboardLayoutCore.tsx");
    expect(core).toContain("name={profileOwnerName(profileData) ?? null}");
    expect(core).toContain("Actions run as");
    for (const layout of [
      "app/dashboard/consultee/[consulteeId]/ConsulteeDashboardLayout.tsx",
      "app/dashboard/consultant/[consultantId]/ConsultantDashboardLayout.tsx",
    ]) {
      expect(read(layout)).toContain(
        "profileOwnerName={(profile) => profile?.user?.name}",
      );
    }
    const user360 = read(
      "app/dashboard/(backoffice)/[tree]/users/[userId]/User360Client.tsx",
    );
    expect(user360).not.toContain("You see it read-only");
    expect(user360).toContain("Anything you do there runs as you");
  });

  it("R4b — shell and operator list render one text on server and client", () => {
    expect(
      read("components/dashboard/shared/OperatorAppointmentsClient.tsx"),
    ).not.toContain("toLocaleString(");
    expect(
      read("components/dashboard/shared/OperatorAppointmentsPage.tsx"),
    ).toContain("<DisplayZoneProvider zone={viewerZone.zone}>");
    expect(read("components/dashboard/ContextSwitcher.tsx")).toContain(
      "const user = hydrated ? session?.user : undefined;",
    );
    // The header bell waits for hydration like the switcher.
    expect(read("components/notifications/NotificationInbox.tsx")).toContain(
      "if (!hydrated || !session?.user?.id || !NOVU_APP_ID) {",
    );
  });

  it("B10 — the typed phrase is for jobs that move money only", () => {
    const job = (id: string, jobName: string, category: JobCategory) => ({
      id,
      jobName,
      category,
    });
    expect(
      runConfirmPhrase(
        job("abandoned-payments", "cleanup-abandoned-payments", "Payments"),
      ),
    ).toBeNull();
    expect(
      runConfirmPhrase(job("auth-tokens", "cleanup-auth-tokens", "Cleanup")),
    ).toBeNull();
    expect(
      runConfirmPhrase(job("process-payouts", "process-payouts", "Payouts")),
    ).toBe("RUN PAYOUTS");
    expect(
      runConfirmPhrase(
        job("reconcile-refunds", "reconcile-pending-refunds", "Refunds"),
      ),
    ).toBe("reconcile-refunds");
  });
});
