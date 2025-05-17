"use client";

import { useRouter } from "next/navigation";
import { use, useEffect } from "react";

export default function ConsultantDashboard({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;
  const router = useRouter();

  useEffect(() => {
    if (consultantId) {
      router.replace(`/dashboard/consultant/${consultantId}/home`);
    }
  }, [consultantId, router]);

  return null;
}
