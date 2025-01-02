import { redirect } from "next/navigation";

export default function ConsulteePage({
  params,
}: {
  params: { consulteeId: string };
}) {
  redirect(`/dashboard/consultee/${params.consulteeId}/home`);
}
