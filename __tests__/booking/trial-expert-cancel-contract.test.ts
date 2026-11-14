/**
 * The expert's "Cancel trial" on the trial's appointment page: the detail view
 * model carries the trial id the action is keyed by, and what the action sends
 * is the body the trial DELETE door parses.
 */

import fs from "fs";
import path from "path";
import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import { TrialCancelBodySchema, trialCancelRequest } from "@/schemas/trials";

const trialDetail = {
  appointment: {
    id: "appt-trial-1",
    appointmentType: "TRIAL",
    organizationId: null,
    occurrences: [],
    payment: [],
    participants: [],
    rescheduleRequests: [],
    trial: {
      id: "trial-row-1",
      status: "SCHEDULED",
      subscriptionPlan: {
        title: "Mentorship",
        trialPriceInPaise: 0,
        trialDurationMinutes: 30,
        consultantProfile: { id: "cp-1", user: { name: "Hannah" } },
      },
      consulteeProfile: { user: { name: "Charlotte" } },
    },
  },
} as unknown as TAppointmentDetail;

describe("the expert cancels a scheduled trial from its appointment page", () => {
  it("the detail view model carries the trial id the cancel door is keyed by", () => {
    const { vm } = mapAppointmentDetail(trialDetail, "consultant");
    expect(vm.trialId).toBe("trial-row-1");
    expect(vm.status).toBe("SCHEDULED");
  });

  it("sends what the trial DELETE route parses, quoted or not", () => {
    const routeFile = path.join(
      process.cwd(),
      "app/api/trials/[trialId]/route.ts",
    );
    expect(fs.readFileSync(routeFile, "utf8")).toContain(
      "TrialCancelBodySchema.safeParse(",
    );
    const quoted = trialCancelRequest("trial-row-1", {
      estimatedRefundPaise: 50_000,
    });
    const bare = trialCancelRequest("trial-row-1");
    expect(quoted.url).toBe("/api/trials/trial-row-1");
    expect(TrialCancelBodySchema.parse(quoted.body)).toEqual({
      confirmedRefundPaise: 50_000,
    });
    expect(TrialCancelBodySchema.parse(bare.body)).toEqual({});
  });
});
