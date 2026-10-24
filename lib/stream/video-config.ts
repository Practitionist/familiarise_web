import prisma, { type PrismaLike } from "@/lib/prisma";
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
  const row = await db.platformVideoConfig.findUnique({
    where: { id: VIDEO_CONFIG_ID },
    select: {
      callTargetResolution: true,
      recordingQuality: true,
      screenshareTargetResolution: true,
    },
  });
  return row ? storedVideoConfigSchema.parse(row) : { ...DEFAULT_VIDEO_CONFIG };
}
