import prisma, { type PrismaLike } from "@/lib/prisma";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import {
  DEFAULT_VIDEO_CONFIG,
  storedVideoConfigSchema,
  type PlatformVideoConfig,
} from "@/lib/stream/video-quality";

export const VIDEO_CONFIG_ID = "singleton";

/** The staff-chosen video quality, or the defaults while no row exists. */
export async function getPlatformVideoConfig(
  db: PrismaLike = prisma,
): Promise<PlatformVideoConfig> {
  // Quality is never worth a failed room: an unreadable config falls back to the defaults.
  try {
    const row = await db.platformVideoConfig.findUnique({
      where: { id: VIDEO_CONFIG_ID },
      select: {
        callTargetResolution: true,
        recordingQuality: true,
        screenshareTargetResolution: true,
      },
    });
    return row
      ? storedVideoConfigSchema.parse(row)
      : { ...DEFAULT_VIDEO_CONFIG };
  } catch (error) {
    captureThrottled("platform-video-config-read", error, {
      subsystem: "stream",
      level: "warning",
      op: "video-config.read",
    });
    return { ...DEFAULT_VIDEO_CONFIG };
  }
}
