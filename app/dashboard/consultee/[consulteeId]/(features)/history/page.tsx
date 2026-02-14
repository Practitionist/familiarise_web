"use client";

import { use } from "react";
import { redirect } from "next/navigation";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

export default function HistoryPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);
  redirect(`/dashboard/consultee/${consulteeId}/appointments`);
}
