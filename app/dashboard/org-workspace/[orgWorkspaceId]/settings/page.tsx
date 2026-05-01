/**
 * Operator-side settings — scaffold for v1.
 *
 * Storage decision deferred (no schema column yet for default landing
 * org or operator-level notification preferences). The page exists so
 * the sidebar item routes correctly and the v1.1 PR has a clear home.
 */

import { DashboardHeader, DashboardContent } from "@/components/dashboard/DashboardShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function OrgWorkspaceSettingsPage() {
  return (
    <>
      <DashboardHeader
        title="Settings"
        subtitle="Operator-level preferences across all your organisations"
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Coming soon</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Operator preferences are scoped to your OrgWorkspace profile, not
              to any single organisation. The following toggles are planned
              for the next release:
            </p>
            <ul className="ml-5 list-disc space-y-1">
              <li>
                Default landing organisation — open this org by default
                instead of the operator overview.
              </li>
              <li>
                Notification routing — choose which org-lifecycle events
                page you on the Novu bell vs. email digest.
              </li>
              <li>
                Locale + currency display — applies across the per-org
                dashboards you visit.
              </li>
            </ul>
            <p className="pt-2">
              For per-organisation settings (branding, SSO, billing
              configuration), open the specific org from the Overview tab
              and use that org&apos;s Settings page.
            </p>
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
