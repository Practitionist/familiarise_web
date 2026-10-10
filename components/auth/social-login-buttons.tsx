"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { signIn } from "@/lib/auth-client";
import { AUTH_PROVIDERS, type AuthProviderId } from "@/lib/auth-providers";
import { humanizeAuthError } from "@/lib/labels/auth-errors";
import { PROVIDER_ICONS } from "@/components/auth/auth-icons";
import { useConfiguredSocialProviders } from "@/components/auth/social-providers-context";
import { Building2 } from "lucide-react";

interface SocialLoginButtonsProps {
  callbackURL: string;
  newUserCallbackURL?: string;
  /** Where a refused OAuth callback lands with `?error=<code>`. */
  errorCallbackURL?: string;
  isLoading: boolean;
  ssoEnforced?: boolean;
  onSSOClick?: () => void;
  ssoChecking?: boolean;
}

export function SocialLoginButtons({
  callbackURL,
  newUserCallbackURL,
  errorCallbackURL = "/auth/signin",
  isLoading,
  ssoEnforced,
  onSSOClick,
  ssoChecking,
}: SocialLoginButtonsProps) {
  const { toast } = useToast();
  const configured = useConfiguredSocialProviders();
  // Success navigates the browser away, so only a failure clears this.
  const [pendingProvider, setPendingProvider] = useState<AuthProviderId | null>(
    null,
  );

  if (ssoEnforced) return null;

  const providers = AUTH_PROVIDERS.filter(({ id }) => configured.includes(id));
  if (providers.length === 0 && !onSSOClick) return null;

  const startSocialSignIn = async (id: AuthProviderId) => {
    setPendingProvider(id);
    let failure: unknown = null;
    try {
      const { error } = await signIn.social({
        provider: id,
        callbackURL,
        newUserCallbackURL: newUserCallbackURL || "/form/onboarding",
        errorCallbackURL,
      });
      failure = error;
    } catch {
      failure = { status: 0 };
    }
    if (!failure) return;
    setPendingProvider(null);
    const copy = humanizeAuthError("signin", failure);
    toast({
      title: copy.title,
      description: copy.description,
      variant: "destructive",
    });
  };

  return (
    <div className="space-y-4">
      {providers.map((provider) => {
        const Icon = PROVIDER_ICONS[provider.id];
        return (
          <Button
            key={provider.id}
            type="button"
            className={`w-full flex items-center justify-center ${provider.className}`}
            disabled={isLoading || pendingProvider !== null}
            aria-busy={pendingProvider === provider.id || undefined}
            onClick={() => void startSocialSignIn(provider.id)}
          >
            {Icon && <Icon className="w-6 h-6 text-white mr-2" />}
            {pendingProvider === provider.id
              ? `Redirecting to ${provider.label}…`
              : provider.label}
          </Button>
        );
      })}
      {onSSOClick && (
        <Button
          type="button"
          className="w-full flex items-center justify-center bg-zinc-700 hover:bg-zinc-600"
          disabled={isLoading || ssoChecking || pendingProvider !== null}
          onClick={onSSOClick}
        >
          <Building2 className="w-5 h-5 text-white mr-2" />
          {ssoChecking ? "Checking…" : "Sign in with Corporate SSO"}
        </Button>
      )}
    </div>
  );
}
