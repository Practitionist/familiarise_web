import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

/**
 * #1527 §17b — "View dashboard" from User 360: an operator reading someone's
 * personal dashboard is recorded (who, whose, why) before the link is handed
 * out, so inspection is never silent. The dashboards themselves already mark
 * the viewer as inspecting (lib/auth/personal-dashboard-access.ts).
 */
export const POST = withOpsAction(
  "users.read",
  "user.view-dashboard",
  { facet: z.enum(["consultant", "consultee"]) },
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const user = await tx.user.findUnique({
        where: { id: params.userId },
        select: {
          consultantProfile: { select: { id: true } },
          consulteeProfile: { select: { id: true } },
        },
      });
      const profileId =
        body.facet === "consultant"
          ? user?.consultantProfile?.id
          : user?.consulteeProfile?.id;
      if (!profileId) {
        throw new OpsRefusal(
          "NO_SUCH_DASHBOARD",
          "This person has no dashboard of that kind.",
          404,
        );
      }
      return {
        target: { kind: "User", id: params.userId },
        after: { facet: body.facet, profileId },
        response: {
          href: `/dashboard/${body.facet}/${profileId}/home`,
        },
      };
    },
  },
);
