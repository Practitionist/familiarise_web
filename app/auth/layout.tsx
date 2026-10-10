import { SocialProvidersProvider } from "@/components/auth/social-providers-context";
import { configuredSocialProviderIds } from "@/lib/auth/social-providers";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <SocialProvidersProvider providers={configuredSocialProviderIds()}>
      {children}
    </SocialProvidersProvider>
  );
}
