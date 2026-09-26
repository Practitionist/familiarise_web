import { permanentRedirect } from "next/navigation";

/** #1527 §13 — Collaborations is a tab of Offerings now; the old URL 308s there. */
export default async function CollaborationsRedirectPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(
    `/dashboard/consultant/${consultantId}/offerings/collaborations`,
  );
}
