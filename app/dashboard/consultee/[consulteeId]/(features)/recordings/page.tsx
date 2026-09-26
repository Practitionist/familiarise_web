"use client";

import { ConsulteeRecordingsPage } from "@/components/dashboard/consultee/resources/ConsulteeRecordingsPage";

export default function ConsulteeRecordingsRoute({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  return <ConsulteeRecordingsPage params={params} />;
}
