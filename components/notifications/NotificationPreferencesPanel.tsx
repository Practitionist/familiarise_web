"use client";

import { useState } from "react";
import Link from "next/link";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  DATA_CONSENT_ANCHOR,
  accountSettingsHref,
} from "@/lib/dashboard/account-href";
import type { EmailCategoryColumn } from "@/lib/email/preferences";
import {
  receivableSwitches,
  showsQuietHours,
} from "@/lib/notifications/receivable";
import { ALWAYS_SENT_LINE } from "@/lib/notifications/required-notices";
import {
  NotificationPreferenceSchema,
  QUIET_HOURS_DEFAULT_END,
  QUIET_HOURS_DEFAULT_START,
  WallClockTimeSchema,
  type NotificationPreference,
} from "@/schemas/user";

type Preferences = NotificationPreference;
type PreferenceUpdate = Partial<Preferences>;

/** Keys that hold a boolean, i.e. the ones a Switch edits. */
type BooleanPreferenceKey = {
  [K in keyof Preferences]: Preferences[K] extends boolean ? K : never;
}[keyof Preferences];

interface ToggleField<K extends BooleanPreferenceKey = BooleanPreferenceKey> {
  key: K;
  label: string;
  description: string;
}

const SAVE_KEY = ["notification-preferences", "save"] as const;

const CHANNEL_FIELDS: ToggleField[] = [
  {
    key: "inAppEnabled",
    label: "In-app notifications",
    description:
      "Optional notifications in the bell. Required notices still appear.",
  },
  {
    key: "emailEnabled",
    label: "Email notifications",
    description: "Optional emails. Required emails still arrive.",
  },
];

const CATEGORY_FIELDS: ToggleField<EmailCategoryColumn>[] = [
  {
    key: "appointmentReminders",
    label: "Bookings & sessions",
    description:
      "Bookings, reminders, unread chat, recordings, documents and collaborator updates, except the changes the other person makes to your booking",
  },
  {
    key: "paymentNotifications",
    label: "Payments & earnings",
    description:
      "Payment links, refunds, disputes, payouts and referral credit",
  },
  {
    key: "supportUpdates",
    label: "Support Cases",
    description: "Updates on your support cases",
  },
  {
    key: "feedbackAlerts",
    label: "Feedback & reviews",
    description: "Reviews, product feedback replies and moderation outcomes",
  },
  {
    key: "trialNotifications",
    label: "Trial sessions",
    description: "Trial session requests and updates",
  },
  {
    key: "subscriptionAlerts",
    label: "Subscriptions",
    description: "Subscription starts, renewals and cancellations",
  },
];

const ORG_CATEGORY_FIELDS: ToggleField<EmailCategoryColumn>[] = [
  {
    key: "orgBillingAlerts",
    label: "Billing & payouts",
    description:
      "Invoices, overdue-payment reminders, wallet balance, payouts, and extra charges",
  },
  {
    key: "orgMembershipAlerts",
    label: "Membership",
    description: "Invitations, roster changes, and role updates",
  },
  {
    key: "orgProgramAlerts",
    label: "Programs",
    description: "Seats, cap warnings, exhausted programs, and renewals",
  },
];

/** Keep in sync with staff settings. */
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

async function fetchPreferences(): Promise<Preferences> {
  const res = await fetch("/api/novu/preferences");
  if (!res.ok) throw new Error("Failed to load preferences");
  return NotificationPreferenceSchema.parse(await res.json());
}

async function savePreferences(update: PreferenceUpdate): Promise<Preferences> {
  const res = await fetch("/api/novu/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error("Failed to update preferences");
  return NotificationPreferenceSchema.parse(await res.json());
}

/** The values `previous` held for the keys `update` changes. */
function previousValues(
  previous: Preferences,
  update: PreferenceUpdate,
): PreferenceUpdate {
  const restored: PreferenceUpdate = {};
  const keys = Object.keys(update).filter(
    (key): key is keyof Preferences => key in previous,
  );
  for (const key of keys) Object.assign(restored, { [key]: previous[key] });
  return restored;
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: Readonly<{
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}>) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p id={`${id}-description`} className="text-xs text-zinc-500">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

/** Saves on blur, never per keystroke; a rollback remounts it through its `key`. */
function QuietHoursTimeField({
  id,
  label,
  saved,
  other,
  disabled,
  onCommit,
}: Readonly<{
  id: string;
  label: string;
  saved: string;
  other: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}>) {
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    if (draft === saved) return setError(null);
    if (!WallClockTimeSchema.safeParse(draft).success) {
      return setError("Enter a complete time.");
    }
    if (draft === other) {
      return setError("Quiet hours must start and end at different times.");
    }
    setError(null);
    onCommit(draft);
  };

  return (
    <div>
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      <Input
        id={id}
        type="time"
        value={draft}
        disabled={disabled}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="mt-1"
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function NotificationPreferencesPanel() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const user = session?.user;
  const queryKey = ["notification-preferences", user?.id] as const;

  const memberships = user?.organizationMemberships ?? [];
  const orgNames = memberships
    .map((m) => m.organizationName)
    .filter((name): name is string => !!name);
  const viewer = {
    role: user?.role,
    consultantProfileId: user?.consultantProfileId,
    hasOrgMembership: memberships.length > 0,
  };
  const switches = receivableSwitches(viewer);
  const accountHref = user ? accountSettingsHref(user, "account") : null;
  const consentHref = accountHref
    ? `${accountHref}#${DATA_CONSENT_ANCHOR}`
    : null;

  const {
    data: prefs,
    isPending,
    error,
  } = useQuery({
    queryKey,
    queryFn: fetchPreferences,
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  // One scope runs saves one at a time, so a late response never lands after a newer save.
  const mutation = useMutation({
    mutationKey: SAVE_KEY,
    scope: { id: "notification-preferences" },
    mutationFn: savePreferences,
    onMutate: async (update: PreferenceUpdate) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Preferences>(queryKey);
      queryClient.setQueryData<Preferences>(queryKey, (old) =>
        old ? { ...old, ...update } : old,
      );
      return { previous };
    },
    onError: (_error, update, context) => {
      // Restore only this save's keys: a queued save of another switch keeps its value.
      const previous = context?.previous;
      if (previous) {
        const restored = previousValues(previous, update);
        queryClient.setQueryData<Preferences>(queryKey, (old) =>
          old ? { ...old, ...restored } : previous,
        );
      }
      toast({
        title: "Not saved",
        description: "Your change could not be saved. Please try again.",
        variant: "destructive",
      });
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: SAVE_KEY }) === 1) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  const pendingKeys = new Set(
    useMutationState({
      filters: { mutationKey: SAVE_KEY, status: "pending" },
      select: (m) => m.state.variables,
    }).flatMap((vars) =>
      vars && typeof vars === "object" ? Object.keys(vars) : [],
    ),
  );

  if (isPending) {
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

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-zinc-500">
          Failed to load notification preferences. Please try again.
        </CardContent>
      </Card>
    );
  }

  const save = (update: PreferenceUpdate) => mutation.mutate(update);
  const optionalOff = !prefs.allNotifications;
  const childDisabled = (key: keyof Preferences) =>
    optionalOff || pendingKeys.has(key);

  const renderToggle = (field: ToggleField) => (
    <SwitchRow
      id={`notification-${field.key}`}
      label={field.label}
      description={field.description}
      checked={prefs[field.key]}
      disabled={childDisabled(field.key)}
      onCheckedChange={(checked) => save({ [field.key]: checked })}
    />
  );

  const categoryFields = CATEGORY_FIELDS.filter((f) => switches.has(f.key));
  const orgFields = ORG_CATEGORY_FIELDS.filter((f) => switches.has(f.key));

  // Saved zone, else the browser's: the select, the "(current)" option and the enable save all use it.
  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Asia/Kolkata";
  const effectiveTimezone = prefs.quietHoursTimezone ?? browserTimezone;
  const quietStart = prefs.quietHoursStart ?? QUIET_HOURS_DEFAULT_START;
  const quietEnd = prefs.quietHoursEnd ?? QUIET_HOURS_DEFAULT_END;
  const quietDisabled = optionalOff || !prefs.quietHoursEnabled;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <SwitchRow
            id="notification-allNotifications"
            label="Optional notifications"
            description="Turn off to pause optional emails and in-app notifications. Required notices still arrive: account, security and moderation notices in the bell and by email, plus payment receipts and invitations you must answer by email."
            checked={prefs.allNotifications}
            disabled={pendingKeys.has("allNotifications")}
            onCheckedChange={(checked) => save({ allNotifications: checked })}
          />
          <p
            className="mt-3 text-xs text-zinc-500"
            data-testid="notification-always-sent"
          >
            {ALWAYS_SENT_LINE}
          </p>
          {optionalOff && (
            <p className="mt-3 text-xs text-zinc-500">
              The choices below are kept and apply again when you turn optional
              notifications back on.
            </p>
          )}
        </CardContent>
      </Card>

      <Card aria-disabled={optionalOff}>
        <CardHeader>
          <CardTitle className="text-lg">Channels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {CHANNEL_FIELDS.map((field, index) => (
            <div key={field.key}>
              {index > 0 && <Separator className="mb-4" />}
              {renderToggle(field)}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card aria-disabled={optionalOff}>
        <CardHeader>
          <CardTitle className="text-lg">Categories</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {categoryFields.map((field, index) => (
            <div key={field.key}>
              {index > 0 && <Separator className="mb-4" />}
              {renderToggle(field)}
            </div>
          ))}
          <p className="text-xs text-zinc-500">
            Marketing emails and the newsletter follow your marketing consent
            {consentHref ? (
              <>
                {" "}
                in{" "}
                <Link href={consentHref} className="underline">
                  Data consent &amp; privacy rights
                </Link>
              </>
            ) : null}
            .
          </p>
        </CardContent>
      </Card>

      {orgFields.length > 0 && (
        <Card aria-disabled={optionalOff}>
          <CardHeader>
            <CardTitle className="text-lg">Organization</CardTitle>
            {orgNames.length > 0 && (
              <p className="text-xs text-zinc-500">
                For every organization you belong to: {orgNames.join(", ")}.
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {orgFields.map((field, index) => (
              <div key={field.key}>
                {index > 0 && <Separator className="mb-4" />}
                {renderToggle(field)}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {showsQuietHours(viewer) && (
        <Card aria-disabled={optionalOff}>
          <CardHeader>
            <CardTitle className="text-lg">Email quiet hours</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SwitchRow
              id="notification-quietHoursEnabled"
              label="Hold planning reminders"
              description="The reminder to schedule plan sessions, by email and in the bell, waits until these hours end. Nothing else is delayed."
              checked={prefs.quietHoursEnabled}
              disabled={childDisabled("quietHoursEnabled")}
              onCheckedChange={(checked) =>
                save(
                  checked && !prefs.quietHoursTimezone
                    ? {
                        quietHoursEnabled: true,
                        quietHoursTimezone: browserTimezone,
                      }
                    : { quietHoursEnabled: checked },
                )
              }
            />
            {prefs.quietHoursEnabled && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-4">
                  <QuietHoursTimeField
                    key={`start-${quietStart}`}
                    id="quiet-hours-start"
                    label="Start time"
                    saved={quietStart}
                    other={quietEnd}
                    disabled={
                      quietDisabled || pendingKeys.has("quietHoursStart")
                    }
                    onCommit={(value) => save({ quietHoursStart: value })}
                  />
                  <QuietHoursTimeField
                    key={`end-${quietEnd}`}
                    id="quiet-hours-end"
                    label="End time"
                    saved={quietEnd}
                    other={quietStart}
                    disabled={quietDisabled || pendingKeys.has("quietHoursEnd")}
                    onCommit={(value) => save({ quietHoursEnd: value })}
                  />
                </div>
                <div>
                  <Label htmlFor="quiet-hours-timezone" className="text-sm">
                    Timezone
                  </Label>
                  <select
                    id="quiet-hours-timezone"
                    value={effectiveTimezone}
                    disabled={
                      quietDisabled || pendingKeys.has("quietHoursTimezone")
                    }
                    onChange={(e) =>
                      save({ quietHoursTimezone: e.target.value })
                    }
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {!QUIET_HOURS_TIMEZONES.some(
                      (zone) => zone === effectiveTimezone,
                    ) && (
                      <option value={effectiveTimezone}>
                        {effectiveTimezone} (current)
                      </option>
                    )}
                    {QUIET_HOURS_TIMEZONES.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
