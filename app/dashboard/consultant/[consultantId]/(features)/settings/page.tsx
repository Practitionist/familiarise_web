import { permanentRedirect } from "next/navigation";
import { settingsTabRedirect } from "./settings";
import { SettingsPageClient } from "./SettingsPageClient";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /dashboard/consultant/[consultantId]/settings (#1785). A server component
 * so a retired `?tab=` deep link answers a real 308 rather than a client-side
 * hop: `?tab=availability` now lives at `/availability`.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId } = await params;
  const sp = await searchParams;
  const tab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const target = settingsTabRedirect(
    `/dashboard/consultant/${consultantId}`,
    tab,
  );
  if (target) permanentRedirect(target);
  return <SettingsPageClient consultantId={consultantId} />;
}
