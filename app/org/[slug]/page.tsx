/**
 * @arch4-stub Pending Arch 4-Modified rewrite (Issue #681).
 *
 * Public org profile page (e.g. /org/learnpro-academy). Original impl
 * queried OrganizationProfile by slug; new impl should query Organization
 * directly with `canHost: true, status: "ACTIVE"`.
 */

import { notFound } from "next/navigation";

export default async function OrgProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!slug) notFound();

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Organization: {slug}</h1>
      <p className="mt-4 text-gray-600">
        This public profile is pending Arch 4-Modified rewrite. See Issue #681.
      </p>
    </div>
  );
}
