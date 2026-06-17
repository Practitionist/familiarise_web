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
import { getSession } from "@/lib/auth-server";
import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";

import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolve the session on the server so the Navbar renders the correct auth
  // state on first paint (no signed-out flash). Cheap via the 5-min cookie
  // cache; useSession() takes over client-side for live updates. Fail open: a
  // transient auth/DB error must not 500 the whole app, including public pages.
  let initialSession: Awaited<ReturnType<typeof getSession>> = null;
  try {
    initialSession = await getSession();
  } catch {
    initialSession = null;
  }

  return (
    <html lang="en" className={sora.variable} suppressHydrationWarning>
      <body
        className={`${sora.className} flex flex-col min-h-screen antialiased`}
        suppressHydrationWarning
      >
        <ReactQueryProvider>
          <AuthSyncProvider />
          <MaintenanceProvider>
            <AnnouncementBarProvider>
              <NavigationProgress />
              <Toaster />
              <MaintenanceBanner />
              <AnnouncementBar />
              <Navbar initialSession={initialSession} />
              <HeaderSpacer />
              <div className="flex-1 w-full">{children}</div>
              <Footer />
            </AnnouncementBarProvider>
            <CookieConsentBanner />
          </MaintenanceProvider>
        </ReactQueryProvider>
      </body>
    </html>
  );
}
