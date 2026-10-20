import { permanentRedirect } from "next/navigation";
import { settingsTabRedirect } from "./settings";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** The layout renders the grouped hub; old tab links redirect to their form URL. */
export default async function SettingsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId } = await params;
  const sp = await searchParams;
  const tab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  if (!tab) return null;
  permanentRedirect(
    settingsTabRedirect(`/dashboard/consultant/${consultantId}`, tab),
  );
}
