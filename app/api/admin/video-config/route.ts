/**
 * GET   /api/admin/video-config — the staff-chosen call, screen-share and recording quality.
 * PATCH /api/admin/video-config — STAFF + ADMIN edit with a reason; audited in OpsActionLog.
 */
import { NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import {
  getPlatformVideoConfig,
  VIDEO_CONFIG_ID,
} from "@/lib/stream/video-config";
import { videoConfigPatchShape } from "@/lib/stream/video-quality";

export async function GET() {
  const auth = await requireBackofficeSurface("videoConfig.manage");
  if (auth.error) return auth.error;
  return NextResponse.json({ config: await getPlatformVideoConfig() });
}

export const PATCH = withOpsAction(
  "videoConfig.manage",
  "videoConfig.update",
  videoConfigPatchShape,
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const {
        callTargetResolution,
        recordingQuality,
        screenshareTargetResolution,
      } = ctx.body;
      if (
        callTargetResolution === undefined &&
        recordingQuality === undefined &&
        screenshareTargetResolution === undefined
      ) {
        throw new OpsRefusal("EMPTY_PATCH", "Change at least one value.", 400);
      }
      const before = await getPlatformVideoConfig(tx);
      await tx.platformVideoConfig.upsert({
        where: { id: VIDEO_CONFIG_ID },
        create: {
          id: VIDEO_CONFIG_ID,
          callTargetResolution:
            callTargetResolution ?? before.callTargetResolution,
          recordingQuality: recordingQuality ?? before.recordingQuality,
          screenshareTargetResolution:
            screenshareTargetResolution ?? before.screenshareTargetResolution,
          updatedById: ctx.actor.userId,
        },
        update: {
          callTargetResolution,
          recordingQuality,
          screenshareTargetResolution,
          updatedById: ctx.actor.userId,
        },
      });
      const after = await getPlatformVideoConfig(tx);
      return {
        target: { kind: "PlatformVideoConfig", id: VIDEO_CONFIG_ID },
        response: { config: after },
        before,
        after,
      };
    },
  },
);
