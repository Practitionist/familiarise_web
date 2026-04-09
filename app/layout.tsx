import AnnouncementBar from "@/components/AnnouncementBar";
import MaintenanceBanner from "@/components/banners/MaintenanceBanner";
import CookieConsentBanner from "@/components/CookieConsent";
import Footer from "@/components/Footer";
import HeaderSpacer from "@/components/HeaderSpacer";
import Navbar from "@/components/Navbar";
import NavigationProgress from "@/components/NavigationProgress";
import { Toaster } from "@/components/ui/toaster";
import { AnnouncementBarProvider } from "@/providers/AnnouncementBarProvider";
import { MaintenanceProvider } from "@/providers/MaintenanceProvider";
import ReactQueryProvider from "@/providers/ReactQueryProvider";
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
  return (
    <html lang="en" className={sora.variable} suppressHydrationWarning>
      <body
        className={`${sora.className} flex flex-col min-h-screen antialiased`}
        suppressHydrationWarning
      >
        <ReactQueryProvider>
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
