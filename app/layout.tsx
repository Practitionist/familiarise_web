import AnnouncementBar from "@/components/AnnouncementBar";
import MaintenanceBanner from "@/components/banners/MaintenanceBanner";
import CookieConsentBanner from "@/components/CookieConsent";
import Footer from "@/components/Footer";
import HeaderSpacer from "@/components/HeaderSpacer";
import Navbar from "@/components/Navbar";
import NavigationProgress from "@/components/NavigationProgress";
import { Toaster } from "@/components/ui/toaster";
import { AnnouncementBarProvider } from "@/providers/AnnouncementBarProvider";
import AuthSyncProvider from "@/providers/AuthSyncProvider";
import { MaintenanceProvider } from "@/providers/MaintenanceProvider";
import ReactQueryProvider from "@/providers/ReactQueryProvider";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";
import type { Metadata, Viewport } from "next";

import { fraunces, inter, sora } from "@/lib/fonts";

import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const SITE_DESCRIPTION =
  "Connect with world-class experts for 1-on-1 sessions, classes, webinars, and personalized career guidance. Transform your career with Familiarise.";
const SITE_TITLE = "Familiarise | Expert Consultations & Career Mentorship";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: [
    "consulting",
    "mentorship",
    "career guidance",
    "expert sessions",
    "webinars",
    "professional development",
  ],
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    url: "/",
    siteName: "Familiarise",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
};

// Intentionally NO server-side session read here. Calling getSession() invokes
// headers(), which forces the ENTIRE app to render dynamically — so even the
// loading.tsx skeletons had to wait on a (cold) server render, which is why a
// soft navigation sat blank for ~20-30s before the skeleton appeared. Keeping
// the root layout static lets the shell + loading skeletons prefetch and paint
// instantly; the Navbar hydrates the session client-side via useSession(), and
// AuthSyncProvider keeps it live. The brief first-paint unknown state is shown
// as a neutral placeholder in the Navbar rather than a signed-out flash. (#932)
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // `inter` is the text face and carries the weight axis; `sora` stays on
      // the element for the landing typography that still references it, and
      // `fraunces` is declared here but only ever fetched by a browser that
      // has the editorial direction active (globals.css scopes it to
      // `body[data-theme="editorial"]`).
      className={`${inter.variable} ${fraunces.variable} ${sora.variable}`}
    >
      <body
        className={`${inter.className} flex flex-col min-h-svh antialiased`}
      >
        {/* Renders null and writes the theme attributes to the body element in
            an effect, which is why this layout needs no pre-paint script and
            no hydration escape hatch. See components/theme/ThemeProvider.tsx
            for why, and __tests__/dashboards/shell-overflow-contract.test.ts
            for the assertion that forbids the usual alternative. */}
        <ThemeProvider />
        <ReactQueryProvider>
          <AuthSyncProvider />
          <MaintenanceProvider>
            <AnnouncementBarProvider>
              <NavigationProgress />
              <Toaster />
              <MaintenanceBanner />
              <AnnouncementBar />
              <Navbar />
              <HeaderSpacer />
              <div className="flex-1 w-full">{children}</div>
              <Footer />
            </AnnouncementBarProvider>
            <CookieConsentBanner />
          </MaintenanceProvider>
        </ReactQueryProvider>
        {/* Dev/review affordance: renders nothing unless `?themes=1` is
            present or NODE_ENV is not production. Kept outside the providers
            so it cannot be re-parented by a portal. */}
        <ThemeSwitcher />
      </body>
    </html>
  );
}
