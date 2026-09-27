import { PersonalSupportRequests } from "@/app/support/_components/PersonalSupportRequests";

/** Support requests (#1527) — Requests · Feedback, plus suggested articles. */
export default async function SupportPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}>) {
  const [{ consultantId }, { tab }] = await Promise.all([params, searchParams]);
  return (
    <PersonalSupportRequests
      tree="consultant"
      profileId={consultantId}
      tab={tab}
    />
  );
}
