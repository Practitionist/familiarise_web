"use client";

import { redirect } from "next/navigation";
import { use } from "react";

type PageProps = {
  params: Promise<{ staffId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function StaffPage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  redirect(`/dashboard/staff/${resolvedParams.staffId}/home`);
}
