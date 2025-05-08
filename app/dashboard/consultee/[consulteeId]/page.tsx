"use client";

import { useRouter } from "next/navigation";
import { use, useEffect } from "react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsulteePage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consulteeId = resolvedParams.consulteeId;
  const router = useRouter();

  useEffect(() => {
    if (consulteeId) {
      router.replace(`/dashboard/consultee/${consulteeId}/home`);
    }
  }, [consulteeId, router]);

  return null;
}
