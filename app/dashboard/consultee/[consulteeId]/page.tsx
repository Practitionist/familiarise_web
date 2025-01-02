import { redirect } from "next/navigation";

import { use } from "react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

export default function ConsulteePage({ params }: PageProps) {
  const resolvedParams = use(params);
  redirect(`/dashboard/consultee/${resolvedParams.consulteeId}/home`);
}
