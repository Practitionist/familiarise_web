"use client";

import { Shield, Bell, KeyRound } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import {
  AccountDetailsSection,
  PasswordSection,
  SessionsSection,
  ConnectedAccountsSection,
  ConsentSection,
} from "@/components/dashboard/account";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { TwoFactorSettings } from "@/components/auth/TwoFactorSettings";
import { NotificationPreferencesPanel } from "@/components/notifications/NotificationPreferencesPanel";
import { useSession } from "@/lib/auth-client";

export default function StaffSettingsPage() {
  const { data: session } = useSession();
  const { basePath } = useBackofficeCapability();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Manage your account profile, IANA timezone, sign-in security, active sessions, notifications, and privacy preferences"
      />

      <DashboardContent>
        <div className="max-w-3xl space-y-6">
          <AccountDetailsSection />

          <Card id="sign-in-security">
            <CardHeader>
              <div className="flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle className="text-base">
                    Sign-In &amp; Security
                  </CardTitle>
                  <CardDescription>
                    Manage your password, connected OAuth accounts, active
                    sessions, and two-factor authentication
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <TwoFactorSettings />
              <PasswordSection />
              <ConnectedAccountsSection returnHref={`${basePath}/settings`} />
              <SessionsSection />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle className="text-base">
                    Notification Preferences
                  </CardTitle>
                  <CardDescription>
                    Choose how and when you receive operational alerts and
                    updates
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <NotificationPreferencesPanel />
            </CardContent>
          </Card>

          <ConsentSection />

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle className="text-base">Role &amp; Access</CardTitle>
                  <CardDescription>
                    Your backoffice permissions and capabilities
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg bg-muted p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Current Role</span>
                  <span className="rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                    {session?.user?.role || "STAFF"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Operator capabilities are enforced per surface by the
                  backoffice permission matrix. Contact an administrator if you
                  require additional surface access.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </DashboardContent>
    </>
  );
}
