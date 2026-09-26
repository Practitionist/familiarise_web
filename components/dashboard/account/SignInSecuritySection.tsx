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
      toast({ title: "Password changed" });
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

/** "Log out everywhere": revoke every other session, then sign this one out. */
export function SessionsSection() {
  const { toast } = useToast();
  return (
    <Section
      title="Sessions"
      description="Signed in on a device you no longer use? Sign out of every device at once."
      variant="card"
    >
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
        onConfirm={async () => {
          try {
            await authClient.revokeOtherSessions();
          } catch {
            throw new Error(
              "We couldn't end your other sessions. Please try again.",
            );
          }
          toast({ title: "Signing you out everywhere" });
          await signOutEverywhere("/auth/signin");
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
