"use client";

import { redirect } from "next/navigation";
import { use } from "react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsulteePage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  redirect(`/dashboard/consultee/${resolvedParams.consulteeId}/home`);
}
