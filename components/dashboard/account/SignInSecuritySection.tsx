"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
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
import * as Sentry from "@sentry/nextjs";
import { authClient, useSession } from "@/lib/auth-client";
import { AUTH_PROVIDERS, type AuthProviderId } from "@/lib/auth-providers";
import { PROVIDER_ICONS } from "@/components/auth/auth-icons";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { humanizeAuthError } from "@/lib/labels/auth-errors";
import { normalizeAuthErrorCode } from "@/lib/labels/auth-error-codes";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Which of the three inputs a catalog sentence belongs under.
 *
 * `AuthErrorCopy.field` was written for the sign-in form, which has exactly
 * one password box; this form has two, and the catalog's single `password`
 * value is ambiguous between them. The two length codes are the case that
 * matters — `PASSWORD_TOO_SHORT` says "Use at least 8 characters", which is
 * about the password being *set*, not the one being offered, and parking it
 * under "Current password" sends the customer to edit the wrong field. The
 * code is the only thing that can tell them apart, so the code is what we
 * read; `field` still decides the cases where the ambiguity does not arise.
 *
 * Returns `"form"` for a refusal that belongs to no input, so a 500 renders as
 * a form-level sentence instead of borrowing a field's error slot.
 */
function passwordFieldFor(
  copy: { field?: string },
  error: { code?: string | null },
): "current" | "next" | "form" {
  const code = normalizeAuthErrorCode(error.code);
  if (
    code === "PASSWORD_TOO_SHORT" ||
    code === "PASSWORD_TOO_LONG" ||
    copy.field === "newPassword"
  ) {
    return "next";
  }
  if (copy.field === "password") return "current";
  return "form";
}

interface PasswordErrors {
  current?: string;
  next?: string;
  confirm?: string;
  /**
   * Form-level sentence for a refusal that belongs to no single input.
   *
   * The catalog's `field` is sign-in-shaped ("password" is the password being
   * *offered*, "newPassword" the one being *set*). Dumping every code under
   * `current` — which is what the pre-catalog `error.message` did, since
   * Better Auth returns one free-form string for all of them — points the
   * customer at the wrong box for `PASSWORD_TOO_SHORT` and gives a 500 the
   * visual grammar of a typo.
   */
  form?: string;
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
      // #1856 — a password change must end every other session, or a
      // stolen device survives the reset. BetterAuth does it in the same
      // request, so there is no second call that can fail on its own.
      const { error } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (error) {
        // BEFORE: `error.message` straight into the form. Better Auth's
        // sentence for a wrong current password is "Invalid password", and
        // for a fresh-session requirement it is an internal
        // "SESSION_NOT_FRESH" prose string — developer-facing text under a
        // customer's cursor. AFTER: the code decides the sentence, and the
        // code's `action` decides what the section does next.
        //
        // Flow is `"signin"` because `AuthFlow` has no "account" member and
        // none of the codes reachable here (`INVALID_PASSWORD`,
        // `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`, `FAILED_TO_UPDATE_USER`,
        // the session pair) has a per-flow override — the flow only chooses
        // the last-resort generic, and "signin" is the closest of the five.
        const copy = humanizeAuthError("signin", error);
        setErrors({
          [passwordFieldFor(copy, error)]: copy.description,
        });

        if (copy.action === "sign-in") {
          // `SESSION_EXPIRED` / `SESSION_NOT_FRESH`: the session this form
          // was opened with is dead or too old to authorise a password
          // change. Retrying in place can never succeed, and the
          // revoke-others sweep below would only 401 — so the catalog's
          // `sign-in` action is carried out, using the same helper the
          // session list already uses for the same situation.
          toast({
            title: copy.title,
            description: copy.description,
            variant: "destructive",
          });
          await signOutEverywhere("/auth/signin");
          return;
        }
        return;
      }
      reset();
      toast({
        title: "Password changed",
        description: "Your other devices were signed out.",
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
        {/* A refusal that belongs to no single input — a save that failed, a
            requirement this section cannot satisfy. Rendered through the same
            `FieldError` (and the same `data-field-error` hook the
            scroll-to-first-error helper looks for) so it is announced and
            focusable in the same way as a field sentence. */}
        <FieldError message={errors.form} />
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
 * Observability for revoke failures (#1856): 401 is handled by signing
 * out and 429 is the limiter working as designed — neither is a
 * defect. 5xx/network are, each from one deliberate user click (no
 * throttle needed), and the Sentry user scope set at sign-in says which
 * user. Module scope: it uses no hooks state, so every section shares
 * one stable reference.
 */
function reportRevokeFailure(
  op: "revoke-one" | "revoke-others",
  status: number | null,
  error: unknown,
): void {
  if (status === 401 || status === 429) return;
  Sentry.captureException(
    error instanceof Error ? error : new Error(`sessions-${op} failed`),
    {
      tags: { subsystem: "auth", op: `sessions-${op}` },
      extra: { status },
    },
  );
}

/**
 * "Last active" — the session row's `updatedAt`, which BetterAuth bumps at
 * most once per `updateAge` (1 day). So it is day-granular: "in the last
 * day" or "N days ago", never minutes.
 */
function formatLastActive(iso: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "Active in the last day";
  return days === 1 ? "Last active 1 day ago" : `Last active ${days} days ago`;
}

/**
 * Where you're signed in (#1856): the device list with per-device
 * revoke, "sign out other devices", and "log out everywhere". A revoked
 * device notices on its next server request or tab focus
 * (`AuthSyncProvider`).
 */
/** Why the device list failed to load — the UI says different things. */
type SessionsLoadError = "signed-out" | "retryable";

export function SessionsSection() {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<SessionsLoadError | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<DeviceSession | null>(
    null,
  );

  // Whether any load has ever succeeded. A ref, not state: reading
  // `sessions` here would re-create `load` on every setSessions and
  // re-trigger the mount effect into a refetch loop.
  const hasLoadedRef = useRef(false);
  // One error event per mount: a broken backend 500ing for every visitor
  // must not turn every Retry click into a Sentry event (quota), and
  // 401 (dead session — an expected flow) and 429 (the limiter working
  // as designed) are never defects. The Sentry user scope set at
  // sign-in carries which user this was.
  const loadErrorReportedRef = useRef(false);

  const reportLoadFailure = useCallback(
    (status: number | null, error: unknown) => {
      if (status === 401 || status === 429) return;
      if (loadErrorReportedRef.current) return;
      loadErrorReportedRef.current = true;
      Sentry.captureException(
        error instanceof Error ? error : new Error("sessions-list failed"),
        {
          tags: { subsystem: "auth", op: "sessions-list" },
          extra: { status },
        },
      );
    },
    [],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    let status: number | null = null;
    try {
      const res = await fetch("/api/user/sessions");
      // 401 means THIS session is gone (revoked elsewhere, expired) —
      // retrying the same dead cookie is futile, so say so instead of
      // offering a Retry that can never succeed. Anything else (500,
      // 503, 429, network) is transient: keep the button.
      if (res.status === 401) {
        setLoadError("signed-out");
        return;
      }
      status = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { sessions: DeviceSession[] };
      setSessions(body.sessions);
      hasLoadedRef.current = true;
    } catch (error) {
      reportLoadFailure(status, error);
      // Stale list beats no list: a refresh failure keeps the last known
      // rows (flagged by toast) instead of blanking the section — but a
      // first load with nothing to show gets the Retry block below.
      if (hasLoadedRef.current) {
        toast({
          title: "Couldn't refresh your sessions",
          description: "Showing the last loaded list.",
        });
      } else {
        setLoadError("retryable");
      }
    } finally {
      setIsLoading(false);
    }
  }, [reportLoadFailure, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeOne = useCallback(
    async (target: DeviceSession) => {
      // ConfirmDialog keeps the dialog open with the thrown message shown
      // inline — hence throw, never toast, on failure.
      let res: Response;
      try {
        res = await fetch(`/api/user/sessions/${target.id}`, {
          method: "DELETE",
        });
      } catch (error) {
        reportRevokeFailure("revoke-one", null, error);
        throw new Error("We couldn't end that session. Please try again.");
      }
      // Our own session died mid-dialog (revoked elsewhere, expired):
      // failing the dialog would strand the user — sign out cleanly.
      if (res.status === 401) {
        toast({ title: "Your session ended. Signing you out." });
        await signOutEverywhere("/auth/signin");
        return;
      }
      if (res.status === 429) {
        throw new Error("Too many requests. Wait a moment and try again.");
      }
      let body: { revoked: number; currentSessionEnded: boolean };
      try {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = (await res.json()) as typeof body;
      } catch (error) {
        reportRevokeFailure("revoke-one", res.status, error);
        throw new Error("We couldn't end that session. Please try again.");
      }
      if (body.currentSessionEnded) {
        toast({ title: "Signing you out" });
        await signOutEverywhere("/auth/signin");
        return;
      }
      toast({ title: `Signed out ${target.label}` });
      await load();
    },
    [load, toast],
  );

  const revokeOthers = useCallback(
    async ({ andSignOut }: { andSignOut: boolean }) => {
      let res: Response;
      try {
        res = await fetch("/api/user/sessions/revoke-others", {
          method: "POST",
        });
      } catch (error) {
        reportRevokeFailure("revoke-others", null, error);
        throw new Error(
          "We couldn't end your other sessions. Please try again.",
        );
      }
      // Dead session: nothing else to end that matters — sign out here.
      if (res.status === 401) {
        toast({ title: "Your session ended. Signing you out." });
        await signOutEverywhere("/auth/signin");
        return;
      }
      if (res.status === 429) {
        throw new Error("Too many requests. Wait a moment and try again.");
      }
      let revoked = 0;
      try {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        revoked = ((await res.json()) as { revoked: number }).revoked;
      } catch (error) {
        reportRevokeFailure("revoke-others", res.status, error);
        throw new Error(
          "We couldn't end your other sessions. Please try again.",
        );
      }
      if (andSignOut) {
        toast({ title: "Signing you out everywhere" });
        await signOutEverywhere("/auth/signin");
        return;
      }
      const deviceWord = revoked === 1 ? "device" : "devices";
      toast({
        title:
          revoked > 0
            ? `Signed out ${revoked} other ${deviceWord}`
            : "No other devices to sign out",
      });
      await load();
    },
    [load, toast],
  );

  let sessionsBody: ReactNode;
  if (isLoading && sessions === null && loadError === null) {
    sessionsBody = (
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    );
  } else if (loadError === "signed-out") {
    sessionsBody = (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Your session ended — sign in again to manage your devices.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            window.location.href = "/auth/signin";
          }}
        >
          Sign in again
        </Button>
      </div>
    );
  } else if (loadError === "retryable" || sessions === null) {
    sessionsBody = (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t load your sessions.
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  } else {
    sessionsBody = (
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
                {formatLastActive(s.lastSeenAt)}
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
    );
  }

  return (
    <Section
      title="Sessions"
      description="Every device signed in to your account. Signed in somewhere you don't recognize? End that session."
      variant="card"
    >
      {sessionsBody}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={isLoading || (sessions?.length ?? 0) < 2}
          onClick={() => {
            // Unlike the ConfirmDialog paths, nothing here catches a
            // rejection — surface it as a toast instead of an unhandled
            // rejection with no user feedback.
            revokeOthers({ andSignOut: false }).catch(() => {
              toast({
                title: "We couldn't end your other sessions. Please try again.",
                variant: "destructive",
              });
            });
          }}
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
      // BEFORE: `throw new Error(error.message || …)`, and ConfirmDialog
      // renders a thrown message *verbatim* inside the dialog — so this was
      // the one place a raw Better Auth sentence was guaranteed to reach the
      // screen, on the code path where the customer has just been told the
      // provider is about to be disconnected.
      //
      // AFTER: the catalog owns the sentence. `FAILED_TO_UNLINK_LAST_ACCOUNT`
      // ("You need one way to sign in") is the refusal that actually happens
      // here, and `ACCOUNT_NOT_FOUND` the other; both have copy written for
      // exactly this moment. The dialog gets `"<title>. <description>"`,
      // because a dialog has one slot and the catalog has two sentences.
      const copy = humanizeAuthError("signin", error);
      throw new Error(`${copy.title}. ${copy.description}`);
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
