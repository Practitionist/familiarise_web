"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { InboxPreferenceStatus } from "./InboxPreferenceStatus";
import Link from "next/link";
import { accountSettingsHref } from "@/lib/dashboard/account-href";
import { useToast } from "@/hooks/use-toast";

import {
  NotificationPreferenceSchema,
  type NotificationPreference as NotificationPreferences,
} from "@/schemas/user";

/** Keys that map to boolean values — used for Switch toggle fields. */
type BooleanPreferenceKey = {
  [
    K in keyof NotificationPreferences
  ]: NotificationPreferences[K] extends boolean ? K : never;
}[keyof NotificationPreferences];

interface ToggleField {
  key: BooleanPreferenceKey;
  label: string;
  description: string;
}

const CHANNEL_FIELDS: ToggleField[] = [
  {
    key: "inAppEnabled",
    label: "In-App Notifications",
    description: "Show notifications in the dashboard inbox",
  },
  {
    key: "emailEnabled",
    label: "Email Notifications",
    description: "Receive notification emails",
  },
];

/** Keep the supported zones in sync with staff settings. */
const QUIET_HOURS_TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney",
] as const;

const CATEGORY_FIELDS: ToggleField[] = [
  {
    key: "appointmentReminders",
    label: "Bookings & sessions",
    description:
      "Bookings, reminders, unread chat, recordings, documents and collaborator updates",
  },
  {
    key: "paymentNotifications",
    label: "Payments & earnings",
    description:
      "Payments, refunds, disputes, payouts and referral credit updates",
  },
  {
    key: "supportUpdates",
    label: "Support Cases",
    description: "Updates on your support cases",
  },
  {
    key: "feedbackAlerts",
    label: "Feedback & Reviews",
    description: "New feedback and review notifications",
  },
  {
    key: "trialNotifications",
    label: "Trial Sessions",
    description: "Trial session requests and updates",
  },
  {
    key: "subscriptionAlerts",
    label: "Subscription Updates",
    description: "Subscription renewals and changes",
  },
];

/** Organization controls are shown only to users with an organization membership. */
const ORG_CATEGORY_FIELDS: ToggleField[] = [
  {
    key: "orgBillingAlerts",
    label: "Billing & Payouts",
    description: "Invoices, dunning, wallet balance, payouts, and overages",
  },
  {
    key: "orgMembershipAlerts",
    label: "Membership",
    description: "Invitations, roster changes, and role updates",
  },
  {
    key: "orgProgramAlerts",
    label: "Programs",
    description: "Cap warnings, exhausted programs, and renewals",
  },
];

export function NotificationPreferencesPanel() {
  const { data: session, isPending: sessionPending } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Same predicate the Inbox tabs use, so the two surfaces agree on whether
  // this user has an org context at all.
  const memberships = (session?.user as Record<string, unknown> | undefined)
    ?.organizationMemberships;
  const orgNames = Array.isArray(memberships)
    ? (memberships as { organizationName?: string }[])
        .map((m) => m.organizationName)
        .filter((name): name is string => !!name)
    : [];
  const hasOrgMembership = Array.isArray(memberships) && memberships.length > 0;

  const {
    data: preferences,
    isLoading,
    error,
  } = useQuery<NotificationPreferences>({
    queryKey: ["notification-preferences", session?.user?.id],
    queryFn: async () => {
      const res = await fetch("/api/novu/preferences");
      if (!res.ok) throw new Error("Failed to load preferences");
      return NotificationPreferenceSchema.parse(await res.json());
    },
    enabled: !!session?.user?.id && !sessionPending,
    staleTime: 5 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: async (updates: Partial<NotificationPreferences>) => {
      const res = await fetch("/api/novu/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update preferences");
      return NotificationPreferenceSchema.parse(await res.json());
    },
    onMutate: () => {
      const userId = session?.user?.id;
      if (!userId || sessionPending)
        throw new Error("Your account is still loading");
      return { userId };
    },
    onSuccess: async (data, _updates, context) => {
      queryClient.setQueryData(
        ["notification-preferences", context.userId],
        data,
      );
      await queryClient.invalidateQueries({
        queryKey: ["account-personal-consent", context.userId],
      });
      toast({
        title: "Preferences updated",
        description: "Your notification preferences have been saved.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update preferences. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleToggle = (key: keyof NotificationPreferences, value: boolean) => {
    mutation.mutate({ [key]: value });
  };

  if (sessionPending || isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!session?.user?.id)
    return (
      <p className="text-sm text-muted-foreground">
        Sign in to manage your notification and email preferences.
      </p>
    );

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-zinc-500">
          Failed to load notification preferences. Please try again.
        </CardContent>
      </Card>
    );
  }

  if (!preferences) return null;
  const prefs = preferences;

  // Single source for "which zone the UI shows": saved preference, else the
  // browser zone, else the platform default. Used by the select value, the
  // "(current)" fallback option, and the enable mutation so display and
  // enforcement can never diverge.
  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Asia/Kolkata";
  const effectiveTimezone = prefs.quietHoursTimezone ?? browserTimezone;
  const privacyHref = accountSettingsHref(session?.user ?? {}, "account");

  return (
    <div className="space-y-6" id="notifications-and-emails">
      <div>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage service updates, inbox timing and marketing email choices here.
          Cookie choices stay in Privacy.
        </p>
        {privacyHref && (
          <Link
            href={`${privacyHref}#cookie-preferences`}
            className="text-sm underline underline-offset-4"
          >
            Manage cookie choices
          </Link>
        )}
      </div>
      <InboxPreferenceStatus key={session.user.id} userId={session.user.id} />
      {/* Master Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Delivery controls</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <Label
                htmlFor="optional-notifications"
                className="text-sm font-medium"
              >
                Allow optional notifications &amp; emails
              </Label>
              <p className="text-xs text-zinc-500">
                Pause optional email and inbox updates. Required emails still
                arrive, including account access and security; your choices
                below stay saved. Existing inbox items remain available.
              </p>
            </div>
            <Switch
              id="optional-notifications"
              checked={prefs.allNotifications}
              disabled={mutation.isPending}
              onCheckedChange={(checked) =>
                handleToggle("allNotifications", checked)
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Channel Preferences */}
      {
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Channels</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {CHANNEL_FIELDS.map((field, index) => (
              <div key={field.key}>
                {index > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between">
                  <div>
                    <Label
                      htmlFor={`notification-${field.key}`}
                      className="text-sm font-medium"
                    >
                      {field.label}
                    </Label>
                    <p className="text-xs text-zinc-500">{field.description}</p>
                  </div>
                  <Switch
                    id={`notification-${field.key}`}
                    checked={prefs[field.key]}
                    disabled={!prefs.allNotifications || mutation.isPending}
                    onCheckedChange={(checked) =>
                      handleToggle(field.key, checked)
                    }
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      }

      {/* Category Preferences */}
      {
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Service updates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {CATEGORY_FIELDS.map((field, index) => (
              <div key={field.key}>
                {index > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between">
                  <div>
                    <Label
                      htmlFor={`notification-${field.key}`}
                      className="text-sm font-medium"
                    >
                      {field.label}
                    </Label>
                    <p className="text-xs text-zinc-500">{field.description}</p>
                  </div>
                  <Switch
                    id={`notification-${field.key}`}
                    checked={prefs[field.key]}
                    disabled={!prefs.allNotifications || mutation.isPending}
                    onCheckedChange={(checked) =>
                      handleToggle(field.key, checked)
                    }
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      }

      {/* Organization categories — hidden for users with no membership */}
      {hasOrgMembership && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Organization</CardTitle>
            {/* #1527 — moved here from each org's Settings. Preferences are
                per person, so one set covers every membership. */}
            {orgNames.length > 0 && (
              <p className="text-xs text-zinc-500">
                For every organization you belong to: {orgNames.join(", ")}.
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {ORG_CATEGORY_FIELDS.map((field, index) => (
              <div key={field.key}>
                {index > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between">
                  <div>
                    <Label
                      htmlFor={`notification-${field.key}`}
                      className="text-sm font-medium"
                    >
                      {field.label}
                    </Label>
                    <p className="text-xs text-zinc-500">{field.description}</p>
                  </div>
                  <Switch
                    id={`notification-${field.key}`}
                    checked={prefs[field.key]}
                    disabled={!prefs.allNotifications || mutation.isPending}
                    onCheckedChange={(checked) =>
                      handleToggle(field.key, checked)
                    }
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Quiet Hours */}
      {
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Quiet Hours</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label
                  htmlFor="quiet-hours-enabled"
                  className="text-sm font-medium"
                >
                  Enable Quiet Hours
                </Label>
                <p className="text-xs text-zinc-500">
                  Delay routine inbox notifications during these hours. Urgent
                  inbox alerts bypass quiet hours; email is not delayed.
                </p>
              </div>
              <Switch
                id="quiet-hours-enabled"
                checked={prefs.quietHoursEnabled}
                disabled={!prefs.allNotifications || mutation.isPending}
                onCheckedChange={(checked) =>
                  checked
                    ? mutation.mutate({
                        quietHoursEnabled: true,
                        quietHoursStart: prefs.quietHoursStart ?? "22:00",
                        quietHoursEnd: prefs.quietHoursEnd ?? "08:00",
                        quietHoursTimezone: effectiveTimezone,
                      })
                    : handleToggle("quietHoursEnabled", false)
                }
              />
            </div>
            {prefs.quietHoursEnabled && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm">Start Time</Label>
                    <Input
                      type="time"
                      value={prefs.quietHoursStart ?? "22:00"}
                      disabled={!prefs.allNotifications || mutation.isPending}
                      onChange={(e) =>
                        mutation.mutate({ quietHoursStart: e.target.value })
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-sm">End Time</Label>
                    <Input
                      type="time"
                      value={prefs.quietHoursEnd ?? "08:00"}
                      disabled={!prefs.allNotifications || mutation.isPending}
                      onChange={(e) =>
                        mutation.mutate({ quietHoursEnd: e.target.value })
                      }
                      className="mt-1"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="quiet-hours-timezone" className="text-sm">
                    Timezone
                  </Label>
                  <select
                    id="quiet-hours-timezone"
                    value={effectiveTimezone}
                    disabled={!prefs.allNotifications || mutation.isPending}
                    onChange={(e) =>
                      mutation.mutate({ quietHoursTimezone: e.target.value })
                    }
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                  >
                    {!QUIET_HOURS_TIMEZONES.includes(
                      effectiveTimezone as (typeof QUIET_HOURS_TIMEZONES)[number],
                    ) && (
                      <option
                        value={effectiveTimezone}
                        disabled={!prefs.allNotifications || mutation.isPending}
                      >
                        {effectiveTimezone} (current)
                      </option>
                    )}
                    {QUIET_HOURS_TIMEZONES.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-zinc-500">
                    Routine inbox notifications pause during these hours and
                    deliver afterwards.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      }
      <Card id="marketing-emails">
        <CardHeader>
          <CardTitle className="text-lg">Marketing emails</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label
                htmlFor="marketing-email-consent"
                className="text-sm font-medium"
              >
                Products and offers
              </Label>
              <p className="text-xs text-muted-foreground">
                Allow Familiarise to email you about products and offers. This
                records marketing consent; it does not enable marketing cookies
                or subscribe you to the newsletter.
              </p>
            </div>
            <Switch
              id="marketing-email-consent"
              checked={prefs.marketingEmails}
              disabled={mutation.isPending}
              onCheckedChange={(value) =>
                handleToggle("marketingEmails", value)
              }
            />
          </div>
          {(!prefs.allNotifications || !prefs.emailEnabled) && (
            <p className="text-sm text-muted-foreground">
              Marketing delivery is paused by your delivery controls. You can
              still grant or withdraw consent here.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Newsletter membership is separate and still needs its own
            confirmation. Withdrawing consent also stops a matching current
            newsletter subscription.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
