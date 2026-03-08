"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { signIn } from "@/lib/auth-client";
import { AUTH_PROVIDERS } from "@/lib/auth-providers";
import { PROVIDER_ICONS } from "@/components/auth/auth-icons";

interface SocialLoginButtonsProps {
  callbackURL: string;
  newUserCallbackURL?: string;
  isLoading: boolean;
}

export function SocialLoginButtons({
  callbackURL,
  newUserCallbackURL,
  isLoading,
}: SocialLoginButtonsProps) {
  const { toast } = useToast();

  return (
    <div className="space-y-4">
      {AUTH_PROVIDERS.map((provider) => {
        const Icon = PROVIDER_ICONS[provider.id];
        return (
          <Button
            key={provider.id}
            className={`w-full flex items-center justify-center ${provider.className}`}
            disabled={isLoading}
            onClick={() => {
              signIn.social({
                provider: provider.id,
                callbackURL,
                newUserCallbackURL: newUserCallbackURL || "/form/onboarding",
              });
              toast({
                title: `Signing in with ${provider.label}...`,
                description: "Please wait while we redirect you.",
              });
            }}
          >
            {Icon && <Icon className="w-6 h-6 text-white mr-2" />}
            {provider.label}
          </Button>
        );
      })}
    </div>
  );
}
