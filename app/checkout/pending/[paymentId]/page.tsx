import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getSession } from "@/lib/auth-server";
import { readPendingCheckout } from "@/lib/data/pending-checkout";

import { PendingCheckoutClient } from "./PendingCheckoutClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pending payment | Familiarise",
  robots: { index: false, follow: false },
};

/** Owner-only: the reader filters by the session user, so any other id is a 404. */
export default async function PendingCheckoutPage({
  params,
}: Readonly<{ params: Promise<{ paymentId: string }> }>) {
  const { paymentId } = await params;
  const session = await getSession();
  if (!session?.user?.id) notFound();

  const pending = await readPendingCheckout({
    paymentId,
    viewerUserId: session.user.id,
  });
  if (!pending) notFound();

  if (pending.status === "SUCCEEDED") {
    redirect(
      pending.consulteeProfileId
        ? `/dashboard/consultee/${pending.consulteeProfileId}/payments/${pending.paymentId}`
        : "/dashboard",
    );
  }

  return <PendingCheckoutClient pending={pending} />;
}
