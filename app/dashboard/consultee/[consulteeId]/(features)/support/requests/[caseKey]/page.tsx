import { PersonalSupportRequestPage } from "@/app/support/_components/SupportRequestCasePage";

/** #1527 — one support request as a full page (t_<ticket> or b_<booking>). */
export default async function SupportRequestPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consulteeId: string; caseKey: string }>;
  searchParams: Promise<{ intent?: string | string[] }>;
}>) {
  const [{ consulteeId, caseKey }, { intent }] = await Promise.all([
    params,
    searchParams,
  ]);
  return (
    <PersonalSupportRequestPage
      tree="consultee"
      profileId={consulteeId}
      caseKey={caseKey}
      intent={intent}
    />
  );
}
