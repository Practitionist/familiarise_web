"use client";

import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";
import { motion } from "framer-motion";
import { GlobeIcon } from "@/components/auth/auth-icons";

export default function CheckoutLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen w-full bg-background flex flex-col"
    >
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link
            href="/explore/experts"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Explore</span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold tracking-wider text-foreground uppercase"
          >
            <GlobeIcon className="h-4 w-4" />
            <span>Familiarise</span>
          </Link>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <Lock className="h-3 w-3 text-emerald-600" />
            <span>Secure Checkout</span>
          </div>
        </div>
      </header>
      <div className="flex-1 w-full">{children}</div>
    </motion.div>
  );
}
