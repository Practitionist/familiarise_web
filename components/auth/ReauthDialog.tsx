"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient, useSession } from "@/lib/auth-client";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { registerReauthHandler } from "@/lib/auth/reauth-client";

const reauthResponse = z.object({
  ok: z.literal(true).optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Mounted once in the root layout. Step-up-gated calls made through
 * lib/auth/reauth-client.ts open this dialog and retry once it resolves true.
 */
export function ReauthProvider() {
  const { data } = useSession();
  const operator = isOperatorRole(data?.user.role);
  const [open, setOpen] = useState(false);
  const pending = useRef<{
    promise: Promise<boolean>;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const settle = useCallback((ok: boolean) => {
    pending.current?.resolve(ok);
    pending.current = null;
    setOpen(false);
  }, []);

  useEffect(() => {
    registerReauthHandler(() => {
      if (pending.current) return pending.current.promise;
      let resolve: (ok: boolean) => void = () => {};
      const promise = new Promise<boolean>((r) => {
        resolve = r;
      });
      pending.current = { promise, resolve };
      setOpen(true);
      return promise;
    });
    return () => {
      registerReauthHandler(null);
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && settle(false)}>
      <DialogContent>
        {open && <ReauthForm operator={operator} onDone={settle} />}
      </DialogContent>
    </Dialog>
  );
}

function ReauthForm({
  operator,
  onDone,
}: {
  operator: boolean;
  onDone: (ok: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [noPassword, setNoPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/user/reauthenticate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          password,
          ...(operator ? { totpCode: totpCode.trim() } : {}),
        }),
      });
      const parsed = reauthResponse.safeParse(
        await res.json().catch(() => null),
      );
      const body = parsed.success ? parsed.data : {};
      if (res.ok) {
        onDone(true);
        return;
      }
      if (body.code === "NO_PASSWORD") setNoPassword(true);
      setError(body.error ?? "We couldn't confirm it's you. Try again.");
    } catch {
      setError("We couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    setBusy(false);
    if (result.error) {
      setError("Your passkey wasn't accepted. Try again or use your code.");
      return;
    }
    onDone(true);
  };

  const signInAgainHref = `/auth/signin?callbackUrl=${encodeURIComponent(
    `${window.location.pathname}${window.location.search}`,
  )}`;

  return (
    <form onSubmit={submit} aria-describedby="reauth-error" noValidate>
      <DialogHeader>
        <DialogTitle>Confirm it&apos;s you</DialogTitle>
        <DialogDescription>
          {operator
            ? "Enter your password and the code from your authenticator app to continue."
            : "Enter your password to continue."}
        </DialogDescription>
      </DialogHeader>

      {noPassword ? (
        <p className="py-4 text-sm">
          Your account signs in with Google, GitHub or SSO.{" "}
          <a className="underline" href={signInAgainHref}>
            Sign in again
          </a>{" "}
          to continue.
        </p>
      ) : (
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="reauth-password">Password</Label>
            <Input
              id="reauth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </div>
          {operator && (
            <div className="space-y-2">
              <Label htmlFor="reauth-totp">Authenticator code</Label>
              <Input
                id="reauth-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                required
              />
            </div>
          )}
        </div>
      )}

      <p
        id="reauth-error"
        role="alert"
        className="min-h-5 text-sm text-red-600"
      >
        {error}
      </p>

      <DialogFooter className="gap-2">
        {operator && !noPassword && (
          <Button
            type="button"
            variant="outline"
            onClick={signInWithPasskey}
            disabled={busy}
          >
            Use a passkey
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
        {!noPassword && (
          <Button type="submit" disabled={busy || !password}>
            {busy ? "Checking…" : "Continue"}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

export default ReauthProvider;
