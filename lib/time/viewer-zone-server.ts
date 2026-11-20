import { getSession } from "@/lib/auth-server";

import {
  describeViewerZone,
  personalViewerZone,
  type ViewerZone,
} from "./viewer-zone";

/**
 * The viewer's zone for an RSC page, read off the same session field the
 * client hook reads. Pass the result down as a prop so the server render and
 * the hydrating client format every instant from one value.
 */
export async function getViewerZone(
  fallbackZone?: string | null,
): Promise<ViewerZone> {
  const session = await getSession();
  return describeViewerZone({
    userTimezone: session?.user?.timezone ?? null,
    fallbackZone,
  });
}

/** `getViewerZone` for a page under a personal dashboard: labelled when the viewer does not own the profile. */
export async function getPersonalViewerZone(
  kind: "consultee" | "consultant",
  profileId: string,
  fallbackZone?: string | null,
): Promise<ViewerZone> {
  const session = await getSession();
  const owned =
    kind === "consultee"
      ? session?.user?.consulteeProfileId
      : session?.user?.consultantProfileId;
  return personalViewerZone(
    describeViewerZone({
      userTimezone: session?.user?.timezone ?? null,
      fallbackZone,
    }),
    !!owned && owned === profileId,
  );
}
