/**
 * @jest-environment node
 */

/**
 * A cancel refused with nothing committed (the session froze, or another
 * refund must finish first) reaches the person as the server's own sentence,
 * never as the generic "Booking already updated".
 *
 * Source contracts for the hooks (this repo has no React test renderer): each
 * cancel handler reads the refusal before its generic 409 branch.
 */
import fs from "fs";
import path from "path";

import {
  cancelRefusalFrom,
  CancelRefusedError,
} from "@/lib/appointments/cancel-requote";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("cancelRefusalFrom", () => {
  it.each([
    "SESSION_IN_PROGRESS",
    "SESSION_ALREADY_DELIVERED",
    "REFUND_IN_PROGRESS",
    "REFUND_NEEDS_SUPPORT",
  ])("carries the server's sentence for %s", (code) => {
    const refusal = cancelRefusalFrom({ code, error: "Plain sentence." });
    expect(refusal).toBeInstanceOf(CancelRefusedError);
    expect(refusal?.message).toBe("Plain sentence.");
  });

  it("ignores any other answer", () => {
    expect(
      cancelRefusalFrom({ code: "REFUND_QUOTE_CHANGED", error: "x" }),
    ).toBeNull();
    expect(cancelRefusalFrom(null)).toBeNull();
  });
});

describe("every cancel surface shows the refusal", () => {
  it.each([
    "components/appointments/consultee/useEventActions.tsx",
    "app/dashboard/consultant/[consultantId]/(features)/appointments/components/useConsultantEventActions.ts",
  ])("%s reads it before the generic 409 branch", (file) => {
    const source = read(file);
    const refusal = source.indexOf("cancelRefusalFrom(error.body)");
    const generic = source.indexOf("Booking already updated");
    expect(refusal).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(refusal);
  });

  it.each([
    "app/dashboard/organization/[orgId]/appointments/[appointmentId]/OrgActorDetail.tsx",
    "components/dashboard/backoffice/money/PlatformCancelDoor.tsx",
    "components/appointments/consultee/CancelConfirmationDialog.tsx",
  ])("%s turns a refused preview into its sentence", (file) => {
    const source = read(file);
    expect(source).toContain("cancelRefusalFrom(");
    expect(source).toContain("instanceof CancelRefusedError");
  });
});
