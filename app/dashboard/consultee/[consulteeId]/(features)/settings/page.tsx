import { permanentRedirect } from "next/navigation";
import {
  CONSULTEE_SETTINGS_LIST_VIEW,
  CONSULTEE_SETTINGS_SECTIONS,
  consulteeSettingsHref,
} from "./settings";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /dashboard/consultee/[consulteeId]/settings — the hub has no body of its own
 * (#1527 §14, the consultant hub's pattern): a 308 to Account, except
 * `?view=sections`, which the layout renders as the mobile section list.
 */
export default async function ConsulteeSettingsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consulteeId } = await params;
  const sp = await searchParams;
  if (sp.view === CONSULTEE_SETTINGS_LIST_VIEW) return null;
  permanentRedirect(
    consulteeSettingsHref(consulteeId, CONSULTEE_SETTINGS_SECTIONS[0]),
  );
}
