import { PersonalSupportRequestPage } from "@/app/support/_components/SupportRequestCasePage";

/** #1527 — one support request as a full page (t_<ticket> or b_<booking>). */
export default async function SupportRequestPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string; caseKey: string }>;
  searchParams: Promise<{
    intent?: string | string[];
    occurrence?: string | string[];
  }>;
}>) {
  const [{ consultantId, caseKey }, { intent, occurrence }] = await Promise.all(
    [params, searchParams],
  );
  return (
    <PersonalSupportRequestPage
      tree="consultant"
      profileId={consultantId}
      caseKey={caseKey}
      intent={intent}
      occurrence={occurrence}
    />
  );
}
