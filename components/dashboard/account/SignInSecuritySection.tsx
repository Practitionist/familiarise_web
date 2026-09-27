"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Loader2, LogOut, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/dashboard/Section";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  FieldError,
  SettingsSaveBar,
  invalidProps,
} from "@/components/dashboard/SettingsLayout";
import { useToast } from "@/hooks/use-toast";
import { authClient, useSession } from "@/lib/auth-client";
import { postAuthSync } from "@/lib/auth-broadcast";
import { AUTH_PROVIDERS, type AuthProviderId } from "@/lib/auth-providers";
import { PROVIDER_ICONS } from "@/components/auth/auth-icons";
import { signOutEverywhere } from "@/lib/auth/sign-out";

const MIN_PASSWORD_LENGTH = 8;

interface PasswordErrors {
  current?: string;
  next?: string;
  confirm?: string;
}

/** From the retired `/settings/change-password` page (#1527 §14). */
export function PasswordSection() {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [isSaving, setIsSaving] = useState(false);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setErrors({});
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: PasswordErrors = {};
    if (!current) found.current = "Enter your current password.";
    if (next.length < MIN_PASSWORD_LENGTH)
      found.next = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (confirm !== next)
      found.confirm = "This doesn't match the new password.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setIsSaving(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      if (error) {
        setErrors({
          current: error.message || "That password didn't work.",
        });
        return;
      }
      reset();
      // #1856 — a password change must end every other session, or a
      // stolen device survives the reset. Best-effort: the password
      // itself already changed, so a sweep failure only affects the
      // toast copy, never the outcome.
      let swept = false;
      try {
        const res = await fetch("/api/user/sessions/revoke-others", {
          method: "POST",
        });
        swept =
          res.ok && ((await res.json()) as { revoked: number }).revoked > 0;
      } catch {
        swept = false;
      }
      toast({
        title: "Password changed",
        description: swept ? "Your other devices were signed out." : undefined,
      });
    } catch {
      toast({
        title: "Couldn't change your password",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const isDirty = !!(current || next || confirm);

  return (
    <Section
      title="Password"
      description="The password you sign in with."
      variant="card"
    >
      <form onSubmit={submit} className="space-y-4">
        {(
          [
            [
              "current",
              "Current password",
              current,
              setCurrent,
              "current-password",
            ],
            ["next", "New password", next, setNext, "new-password"],
            [
              "confirm",
              "Confirm new password",
              confirm,
              setConfirm,
              "new-password",
            ],
          ] as const
        ).map(([key, label, value, setValue, autoComplete]) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`password-${key}`}>{label}</Label>
            <Input
              id={`password-${key}`}
              type="password"
              autoComplete={autoComplete}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={isSaving}
              {...invalidProps(errors[key], `password-${key}-error`)}
            />
            <FieldError id={`password-${key}-error`} message={errors[key]} />
          </div>
        ))}
        <SettingsSaveBar
          isSaving={isSaving}
          isDirty={isDirty}
          onReset={reset}
          saveLabel="Change password"
        />
      </form>
    </Section>
  );
}

interface DeviceSession {
  id: string;
  label: string;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
  isImpersonated: boolean;
}

/**
 * "Last seen X ago" — server-validated activity, accurate to ~5 min
 * (see `lib/auth/last-seen.ts`). Never "active now": the cookie cache
 * means most requests never reach the database.
 */
function formatLastSeen(iso: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Last seen just now";
  if (minutes < 60) return `Last seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Last seen 1d ago" : `Last seen ${days}d ago`;
}

/**
 * Where you're signed in (#1856): the device list with per-device
 * revoke, "sign out other devices", and the pre-existing "log out
 * everywhere". Revoking posts a `session-revoked` ping so same-browser
 * peer tabs re-check immediately; the server bumps the cross-device
 * counter for phones left open on a screen.
 */
export function SessionsSection() {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<DeviceSession | null>(
    null,
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetch("/api/user/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { sessions: DeviceSession[] };
      setSessions(body.sessions);
    } catch {
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeOne = useCallback(
    async (target: DeviceSession) => {
      // ConfirmDialog keeps the dialog open with the thrown message shown
      // inline — hence throw, never toast, on failure.
      let body: { revoked: number; currentSessionEnded: boolean };
      try {
        const res = await fetch(`/api/user/sessions/${target.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        body = (await res.json()) as typeof body;
      } catch {
        throw new Error("We couldn't end that session. Please try again.");
      }
      if (body.currentSessionEnded) {
        toast({ title: "Signing you out" });
        await signOutEverywhere("/auth/signin");
        return;
      }
      postAuthSync({ type: "session-revoked", sessionId: target.id });
      toast({ title: `Signed out ${target.label}` });
      await load();
    },
    [load, toast],
  );

  const revokeOthers = useCallback(
    async ({ andSignOut }: { andSignOut: boolean }) => {
      let revoked = 0;
      try {
        const res = await fetch("/api/user/sessions/revoke-others", {
          method: "POST",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        revoked = ((await res.json()) as { revoked: number }).revoked;
      } catch {
        throw new Error(
          "We couldn't end your other sessions. Please try again.",
        );
      }
      if (revoked > 0) {
        postAuthSync({ type: "session-revoked", sessionId: "*" });
      }
      if (andSignOut) {
        toast({ title: "Signing you out everywhere" });
        await signOutEverywhere("/auth/signin");
        return;
      }
      toast({
        title:
          revoked > 0
            ? `Signed out ${revoked} other ${revoked === 1 ? "device" : "devices"}`
            : "No other devices to sign out",
      });
      await load();
    },
    [load, toast],
  );

  return (
    <Section
      title="Sessions"
      description="Every device signed in to your account. Signed in somewhere you don't recognize? End that session."
      variant="card"
    >
      {isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : loadFailed || sessions === null ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load your sessions.
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <span className="flex min-w-0 flex-col gap-0.5 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{s.label}</span>
                  {s.isCurrent && (
                    <StatusBadge label="This device" tone="success" size="sm" />
                  )}
                </span>
                <span className="text-muted-foreground">
                  {formatLastSeen(s.lastSeenAt)}
                  {s.ipAddress ? ` · ${s.ipAddress}` : ""}
                </span>
              </span>
              {!s.isCurrent && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRevoke(s)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={isLoading || (sessions?.length ?? 0) < 2}
          onClick={() => void revokeOthers({ andSignOut: false })}
        >
          <LogOut className="mr-1.5 h-4 w-4" />
          Sign out other devices
        </Button>
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              <LogOut className="mr-1.5 h-4 w-4" />
              Log out everywhere
            </Button>
          }
          title="Log out of every device?"
          description="Every active session ends, including this one. You'll sign in again on each device."
          confirmLabel="Log out everywhere"
          tone="destructive"
          onConfirm={() => revokeOthers({ andSignOut: true })}
        />
      </div>
      {/* Per-device confirm, controlled: one dialog for every row. */}
      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        title={`Sign out ${pendingRevoke?.label ?? "this device"}?`}
        description="That device will be signed out immediately. If it wasn't you, change your password too."
        confirmLabel="Sign out device"
        tone="destructive"
        onConfirm={async () => {
          // Close AFTER success: a throw keeps the dialog open with the
          // message inline (ConfirmDialog's contract). The current-device
          // path navigates away, so no close is needed there.
          const target = pendingRevoke;
          if (!target) return;
          await revokeOne(target);
          setPendingRevoke(null);
        }}
      />
    </Section>
  );
}

interface LinkedAccount {
  id: string;
  provider: string;
}

/**
 * Social sign-in providers linked to this account. `returnHref` is where the
 * provider sends the browser back after linking — the Account section itself
 * (#1527 §17b), not the retired `/profile`.
 */
export function ConnectedAccountsSection({
  returnHref,
}: Readonly<{ returnHref: string }>) {
  const { toast } = useToast();
  const { data: session } = useSession();
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await authClient.listAccounts();
      if (!error && data) {
        setAccounts(data.map((a) => ({ id: a.id, provider: a.providerId })));
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unlink = async (providerId: string) => {
    const { error } = await authClient.unlinkAccount({ providerId });
    if (error) {
      throw new Error(error.message || "Could not disconnect this account.");
    }
    toast({ title: "Account disconnected" });
    void load();
  };

  const hasPassword = accounts.some((a) => a.provider === "credential");
  // The last way in cannot be removed, or the account would be unreachable.
  const canUnlink = accounts.length > 1;

  return (
    <Section
      title="Connected accounts"
      description="Signing in with any connected provider opens this same account."
      variant="card"
    >
      {isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <ul className="divide-y divide-border">
          {hasPassword && (
            <li className="flex items-center justify-between gap-3 py-3 first:pt-0">
              <span className="flex items-center gap-3 text-sm">
                <UserRound className="h-5 w-5 text-muted-foreground" />
                <span>
                  <span className="block font-medium text-foreground">
                    Email and password
                  </span>
                  <span className="block text-muted-foreground">
                    {session?.user?.email}
                  </span>
                </span>
              </span>
              <StatusBadge label="Connected" tone="success" size="sm" />
            </li>
          )}
          {AUTH_PROVIDERS.map((provider) => {
            const Icon = PROVIDER_ICONS[provider.id];
            const linked = accounts.some((a) => a.provider === provider.id);
            return (
              <li
                key={provider.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className="flex items-center gap-3 text-sm">
                  {Icon && <Icon className="h-5 w-5 text-muted-foreground" />}
                  <span className="font-medium text-foreground">
                    {provider.label}
                  </span>
                </span>
                {linked ? (
                  <span className="flex items-center gap-2">
                    <StatusBadge label="Connected" tone="success" size="sm" />
                    {canUnlink && (
                      <ConfirmDialog
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Disconnect ${provider.label}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        }
                        title={`Disconnect ${provider.label}?`}
                        description={`You'll no longer be able to sign in with ${provider.label}.`}
                        confirmLabel="Disconnect"
                        tone="destructive"
                        onConfirm={() => unlink(provider.id)}
                      />
                    )}
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void authClient.linkSocial({
                        provider: provider.id as AuthProviderId,
                        callbackURL: returnHref,
                      })
                    }
                  >
                    <Check className="mr-1.5 h-4 w-4" />
                    Connect
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
