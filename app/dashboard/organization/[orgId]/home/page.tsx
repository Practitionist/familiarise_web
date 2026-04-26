import { HomePageClient } from "./HomePageClient";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return <HomePageClient orgId={orgId} />;
}
