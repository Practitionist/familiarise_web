import { notFound } from "next/navigation";

import { requireBackofficePage } from "@/lib/auth-guard";
import { readUser360 } from "@/lib/backoffice/user-360";
import { User360Client } from "./User360Client";

/** #1527 Q5 — User 360, for both trees (actions are admin-only). */
export default async function BackofficeUser360Page({
  params,
}: Readonly<{ params: Promise<{ tree: string; userId: string }> }>) {
  const { tree, userId } = await params;
  await requireBackofficePage("users.read", tree);
  const data = await readUser360(userId);
  if (!data) notFound();
  return <User360Client data={data} />;
}
