"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";

import { BrandWordmark } from "@/components/brand/BrandWordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COMPANY_INFO } from "@/lib/company";
import { NEWSLETTER_NOTICE } from "@/lib/newsletter/notice";
import { isChromeHidden } from "@/lib/navigation/public-chrome";
import { EXPLORE_FIELDS } from "@/lib/navigation/public-nav";
import { domainPath } from "@/lib/explore/domain-slug";

interface FooterLink {
  label: string;
  href: string;
}

// Follows the Navbar's IA (Explore / Solutions / For business) and adds the pages the bar leaves out (Company / Legal).
// Users who miss something in the nav look for it in the footer, so the two
// disagreeing costs clicks.
const FOOTER_COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "Explore",
    links: [
      { label: "Find experts", href: "/explore/experts" },
      { label: "Classes & webinars", href: "/explore/programs" },
      { label: "Digital products", href: "/explore/products" },
      {
        label: "Partner organisations",
        href: "/explore/enterprise/organisations",
      },
    ],
  },
  {
    heading: "Solutions",
    links: [
      { label: "College students", href: "/use-cases/college-students" },
      { label: "Early-career pros", href: "/use-cases/early-career" },
      { label: "Career switchers", href: "/use-cases/career-switchers" },
      { label: "Long-term mentorship", href: "/use-cases/mentorship" },
    ],
  },
  {
    heading: "For business",
    links: [
      { label: "Overview", href: "/enterprise" },
      { label: "Team training", href: "/enterprise/team-training" },
      {
        label: "Corporate mentorship",
        href: "/enterprise/corporate-mentorship",
      },
      { label: "For institutions", href: "/enterprise/institutions" },
      { label: "How funding works", href: "/enterprise/funding" },
      { label: "Security", href: "/enterprise/security" },
      { label: "Book a demo", href: "/enterprise/demo" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Help Center", href: "/support" },
      { label: "Contact", href: "/contactus" },
      { label: "Pricing & fees", href: "/pricing" },
      { label: "How it works", href: "/#how-it-works" },
      { label: "How we rank", href: "/how-we-rank" },
      { label: "Become an expert", href: "/become-an-expert" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Terms & Conditions", href: "/terms" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Cancellation & Refund Policy", href: "/refund" },
      { label: "Grievance Redressal", href: "/grievance" },
    ],
  },
];

// Internal-linking band. A marketplace's value is its long-tail catalog, so
// these deep links are worth more here than another column of company pages.
const EXPERTISE_LINKS: FooterLink[] = EXPLORE_FIELDS.map((name) => ({
  label: name,
  href: domainPath(name),
}));

const Footer: React.FC = () => {
  const pathname = usePathname();
  const [email, setEmail] = useState("");
  const [newsletterStatus, setNewsletterStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");

  // Check if we're on the home page
  const isHomePage = pathname === "/";

  // Route list lives in lib/navigation/public-chrome.ts — it was duplicated
  // across Navbar/Footer/HeaderSpacer and had already drifted.
  if (isChromeHidden(pathname)) return null;

  const subscribeButtonLabel = {
    idle: "Subscribe",
    loading: "Subscribing...",
    success: "Check your email",
    error: "Subscribe",
  }[newsletterStatus];

  const handleNewsletterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || newsletterStatus === "loading") return;

    setNewsletterStatus("loading");
    try {
      const res = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Tagged by surface so the admin list can tell where signups come from.
        body: JSON.stringify({ email, source: "FOOTER" }),
      });
      if (!res.ok) throw new Error("Failed");
      setEmail("");
      setNewsletterStatus("success");
    } catch {
      setNewsletterStatus("error");
    }
  };

  return (
    <footer className="bg-black text-white mt-auto relative overflow-hidden">
      {/* Animated background - only on home page for continuous effect */}
      {isHomePage && (
        <>
          <div className="absolute inset-0">
            <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
            <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
            <div className="absolute top-1/2 right-1/3 w-[300px] h-[300px] bg-zinc-600/15 rounded-full blur-[80px] animate-blob animation-delay-4000" />
          </div>
          <div className="absolute inset-0 grid-pattern opacity-20" />
        </>
      )}

      {/* Newsletter signup — every marketing page, merged with the footer */}
      <div className="relative z-10 border-b border-zinc-800">
        <div className="container mx-auto px-4 md:px-6 py-20 md:py-28">
          <div className="max-w-2xl mx-auto text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center mx-auto mb-6 shadow-lg">
              <MessageSquare className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-fluid-5xl font-bold tracking-tight text-white mb-4">
              Stay in the <span className="silver-text">loop</span>
            </h2>
            <p className="text-lg text-zinc-400 mb-8">
              Product news and launch updates from Familiarise, straight to your
              inbox.
            </p>

            <form
              className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
              onSubmit={handleNewsletterSubmit}
            >
              <Input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-14 bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-400 rounded-xl focus:border-zinc-600 focus:ring-zinc-600"
              />
              <Button
                type="submit"
                size="lg"
                disabled={
                  newsletterStatus === "loading" ||
                  newsletterStatus === "success"
                }
                className="h-14 bg-white text-zinc-900 hover:bg-zinc-200 px-8 rounded-xl font-medium shrink-0"
              >
                {subscribeButtonLabel}
              </Button>
            </form>

            {newsletterStatus === "error" && (
              <p className="text-sm text-red-400 mt-2">
                Something went wrong. Please try again.
              </p>
            )}

            <p className="text-sm text-zinc-400 mt-4">
              {NEWSLETTER_NOTICE}{" "}
              <Link
                href="/privacy"
                className="underline hover:text-zinc-200 transition-colors"
              >
                Privacy Policy
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Main Footer Content */}
      <div className="container mx-auto px-4 md:px-6 py-16 md:py-20 relative z-10">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-8 lg:gap-10">
          {/* Brand Column */}
          <div className="col-span-2 md:col-span-3 lg:col-span-2">
            <Link href="/" className="inline-block mb-6">
              <div className="flex h-10 w-36 items-center">
                <BrandWordmark size="md" tone="inverse" />
              </div>
            </Link>
            <p className="text-zinc-400 text-sm leading-relaxed max-w-xs">
              Live classes, webinars, tutoring and 1-on-1 sessions with experts
              interviewed by our founder.
            </p>
          </div>

          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading}>
              <h3 className="font-semibold text-white mb-4">
                {column.heading}
              </h3>
              <ul className="space-y-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-400 hover:text-white transition-colors inline-flex items-center gap-1"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Expertise band — deep links into the catalog */}
        <div className="mt-12 pt-8 border-t border-zinc-800">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 mb-3">
            Find an expert in
          </h3>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {EXPERTISE_LINKS.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="text-sm text-zinc-400 hover:text-white transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Bar — legal-entity details (name, CIN, registered office,
          contact) render beside the copyright line on every page. */}
      <div className="border-t border-zinc-800 relative z-10">
        <div className="container mx-auto px-4 md:px-6 py-6 space-y-2 text-center md:text-left">
          <p className="text-sm text-zinc-400">
            © {new Date().getFullYear()} Familiarise, operated by{" "}
            {COMPANY_INFO.name}. All rights reserved.
          </p>
          <p className="text-xs text-zinc-400 leading-relaxed">
            CIN: {COMPANY_INFO.cin} · Registered office:{" "}
            {COMPANY_INFO.registeredAddress} · Email:{" "}
            <a
              href={`mailto:${COMPANY_INFO.email}`}
              className="underline hover:text-white transition-colors"
            >
              {COMPANY_INFO.email}
            </a>
            {COMPANY_INFO.phone ? (
              <>
                {" "}
                · Phone:{" "}
                <a
                  href={`tel:${COMPANY_INFO.phone}`}
                  className="underline hover:text-white transition-colors"
                >
                  {COMPANY_INFO.phone}
                </a>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
