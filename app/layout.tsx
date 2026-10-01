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
import type { Metadata, Viewport } from "next";

import { sora } from "@/lib/fonts";

import "./globals.css";
import "./explore-ui.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const SITE_DESCRIPTION =
  "Find expert guidance for your next step. Explore one-to-one consultations, ongoing mentorship, expert-led classes, and live webinars on Familiarise.";
const SITE_TITLE = "Familiarise | Expert Guidance & Live Learning";

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
  icons: {
    icon: { url: "/brand/familiarise-icon.svg", type: "image/svg+xml" },
    apple: { url: "/brand/familiarise-apple-icon.png", sizes: "180x180" },
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    url: "/",
    siteName: "Familiarise",
    locale: "en_US",
    images: [
      {
        url: "/brand/landing-og.png",
        width: 1200,
        height: 630,
        alt: "Familiarise — the right expert, a clearer way forward",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/brand/landing-og.png"],
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
    <html lang="en" className={sora.variable}>
      <body className={`${sora.className} flex flex-col min-h-svh antialiased`}>
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
      </body>
    </html>
  );
}
