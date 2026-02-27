import AnnouncementBar from "@/components/AnnouncementBar";
import MaintenanceBanner from "@/components/banners/MaintenanceBanner";
import CookieConsentBanner from "@/components/CookieConsent";
import Footer from "@/components/Footer";
import HeaderSpacer from "@/components/HeaderSpacer";
import Navbar from "@/components/Navbar";
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

export const metadata: Metadata = {
  title: "Familiarise | Expert Consultations & Career Mentorship",
  description:
    "Connect with world-class experts for 1-on-1 sessions, classes, webinars, and personalized career guidance. Transform your career with Familiarise.",
  keywords: [
    "consulting",
    "mentorship",
    "career guidance",
    "expert sessions",
    "webinars",
    "professional development",
  ],
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
