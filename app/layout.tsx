import AnnouncementBar from "@/components/AnnouncementBar";
import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";
import { Toaster } from "@/components/ui/toaster";
import NextAuthProvider from "@/providers/NextAuthSessionProvider";
import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { Inter } from "next/font/google";
import authOptions from "./api/auth/[...nextauth]/options";

import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ConsultX Labs",
  description: "A consulting platform for the future",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession(authOptions);
  return (
    <html lang="en">
      <body className={`${inter.className} flex flex-col min-h-screen`}>
        <NextAuthProvider session={session}>
          <Toaster />
          <AnnouncementBar />
          <Navbar />
          {children}
          <Footer />
        </NextAuthProvider>
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
