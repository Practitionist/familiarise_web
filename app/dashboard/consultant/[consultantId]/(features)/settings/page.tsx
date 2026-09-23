import { permanentRedirect } from "next/navigation";
import { settingsTabRedirect } from "./settings";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /dashboard/consultant/[consultantId]/settings (#1785 L-2). The hub has no
 * body of its own: every section is a URL under it, so this answers a 308 to
 * the section — a retired `?tab=<key>` link to its section, plain `/settings`
 * to the first one, and `?tab=availability` to the top-level `/availability`.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId } = await params;
  const sp = await searchParams;
  const tab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  permanentRedirect(
    settingsTabRedirect(`/dashboard/consultant/${consultantId}`, tab),
  );
}
