import { permanentRedirect } from "next/navigation";
import { SETTINGS_LIST_VIEW, settingsTabRedirect } from "./settings";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /dashboard/consultant/[consultantId]/settings (#1785 L-2). The hub has no
 * body of its own: every section is a URL under it, so this answers a 308 to
 * the section — a retired `?tab=<key>` link to its section, plain `/settings`
 * to the first one, and `?tab=availability` to the top-level `/availability`.
 * `?view=sections` is the exception: the mobile list of sections.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId } = await params;
  const sp = await searchParams;
  // The layout renders the section list for the mobile list view (#1527).
  if (sp.view === SETTINGS_LIST_VIEW) return null;
  const tab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  permanentRedirect(
    settingsTabRedirect(`/dashboard/consultant/${consultantId}`, tab),
  );
}
