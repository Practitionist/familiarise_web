import { EvidenceRequest } from "@/components/support/EvidenceInbox";
export default async function EvidencePage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 md:p-8">
      <a className="text-sm underline" href="/dashboard">
        Back to dashboard
      </a>
      <EvidenceRequest requestId={requestId} />
    </main>
  );
}
