import AnnouncementBar from "@/components/AnnouncementBar";
import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";
import { PreloadResources } from "@/components/PreloadResources";
import { Toaster } from "@/components/ui/toaster";
import NextAuthProvider from "@/providers/NextAuthSessionProvider";
import ReactQueryProvider from "@/providers/ReactQueryProvider";
import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { Sora } from "next/font/google";
import authOptions from "./api/auth/[...nextauth]/options";

import "@stream-io/video-react-sdk/dist/css/styles.css";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

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
  const session = await getServerSession(authOptions);
  return (
    <html lang="en" className={sora.variable} suppressHydrationWarning>
      <body
        className={`${sora.className} flex flex-col min-h-screen antialiased`}
        suppressHydrationWarning
      >
        <PreloadResources />
        <ReactQueryProvider>
          <NextAuthProvider session={session}>
            <Toaster />
            <AnnouncementBar />
            <Navbar />
            {children}
            <Footer />
          </NextAuthProvider>
        </ReactQueryProvider>
      </body>
    </html>
  );
}

///////////////////////////////////////// CLIENT VERSION /////////////////////////////////////////

// "use client";
// import React from "react";
// import { Provider as ReduxProvider } from "react-redux";
// import { SessionProvider } from "next-auth/react";
// import store from "@/redux/store";
// import "./globals.css";

// export default function RootLayout({
//   children,
// }: Readonly<{
//   children: React.ReactNode;
// }>) {
//   return (
//     <html lang="en">
//       <body>
//         <SessionProvider>
//           <ReduxProvider store={store}>{children}</ReduxProvider>
//         </SessionProvider>
//       </body>
//     </html>
//   );
// }
