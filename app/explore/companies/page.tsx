/**
 * @arch4-stub Pending Arch 4-Modified rewrite (Issue #681).
 *
 * Public company explore page — listed provider orgs with canHost=true.
 * Original impl queried OrganizationProfile; new impl should query
 * Organization with `canHost: true, status: "ACTIVE"`.
 *
 * See docs/enterprise/phase-2-api-rewrite-checklist.md.
 */

export default function ExploreCompaniesPage() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Explore Companies</h1>
      <p className="mt-4 text-gray-600">
        This page is pending Arch 4-Modified rewrite. See Issue #681.
      </p>
    </div>
  );
}
