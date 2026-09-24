"use client";

import React, { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, MessageSquare } from "lucide-react";

// Brand glyphs as inline SVGs — lucide deprecated brand icons, so the footer
// owns these five paths (Font Awesome 6 brand geometry) instead of pulling
// in `react-icons` for a single file.
function BrandIcon({
  viewBox,
  d,
  className,
}: Readonly<{
  viewBox: string;
  d: string;
  className?: string;
}>) {
  return (
    <svg viewBox={viewBox} className={className} fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const XIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    viewBox="0 0 24 24"
    d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
    className={className}
  />
);

const LinkedInIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    viewBox="0 0 448 512"
    d="M416 32H31.9C14.3 32 0 46.5 0 64.3v383.4C0 465.5 14.3 480 31.9 480H416c17.6 0 32-14.5 32-32.3V64.3c0-17.8-14.4-32.3-32-32.3zM135.4 416H69V202.2h66.5V416zm-33.2-243c-21.3 0-38.5-17.3-38.5-38.5S80.9 96 102.2 96c21.2 0 38.5 17.3 38.5 38.5 0 21.3-17.2 38.5-38.5 38.5zm282.1 243h-66.4V312c0-24.8-.5-56.7-34.5-56.7-34.6 0-39.9 27-39.9 54.9V416h-66.4V202.2h63.7v29.2h.9c8.9-16.8 30.6-34.5 62.9-34.5 67.2 0 79.7 44.3 79.7 101.9V416z"
    className={className}
  />
);

const InstagramIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    viewBox="0 0 448 512"
    d="M224.1 141c-63.6 0-114.9 51.3-114.9 114.9s51.3 114.9 114.9 114.9S339 319.5 339 255.9 287.7 141 224.1 141zm0 189.6c-41.1 0-74.7-33.5-74.7-74.7s33.5-74.7 74.7-74.7 74.7 33.5 74.7 74.7-33.6 74.7-74.7 74.7zm146.4-194.3c0 14.9-12 26.8-26.8 26.8-14.9 0-26.8-12-26.8-26.8s12-26.8 26.8-26.8 26.8 12 26.8 26.8zm76.1 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1s-34.4 58-36.2 93.9c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM398.8 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1-9s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z"
    className={className}
  />
);

const YoutubeIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    viewBox="0 0 576 512"
    d="M549.655 124.083c-6.281-23.65-24.787-42.276-48.284-48.597C458.781 64 288 64 288 64S117.22 64 74.629 75.486c-23.497 6.322-42.003 24.947-48.284 48.597-11.412 42.867-11.412 132.305-11.412 132.305s0 89.438 11.412 132.305c6.281 23.65 24.787 41.5 48.284 47.821C117.22 448 288 448 288 448s170.78 0 213.371-11.486c23.497-6.321 42.003-24.171 48.284-47.821 11.412-42.867 11.412-132.305 11.412-132.305s0-89.438-11.412-132.305zm-317.51 213.508V175.185l142.739 81.205-142.739 81.201z"
    className={className}
  />
);

const FacebookIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    viewBox="0 0 512 512"
    d="M512 256C512 114.6 397.4 0 256 0S0 114.6 0 256C0 376 82.7 476.8 191.1 496V322.2h-58.7V256h58.7v-51.3c0-57.9 34.5-89.9 87.2-89.9 25.3 0 51.7 4.5 51.7 4.5v56.8h-29.1c-28.7 0-37.6 17.8-37.6 36v43.2h64l-10.2 66.2h-53.8V496C429.3 476.8 512 376 512 256z"
    className={className}
  />
);

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isChromeHidden } from "@/lib/navigation/public-chrome";
import familiariseLogoWhite from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_white.avif";

interface FooterLink {
  label: string;
  href: string;
  /** Renders the outbound glyph. Flagged explicitly rather than matched on
   *  display text, which silently breaks the moment the copy is reworded. */
  external?: boolean;
}

// Mirrors the Navbar's IA (Explore / Solutions / Enterprise / Company / Legal).
// Users who miss something in the nav look for it in the footer, so the two
// disagreeing costs clicks.
const FOOTER_COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "Explore",
    links: [
      { label: "Find experts", href: "/explore/experts" },
      { label: "Programs", href: "/explore/programs" },
      {
        label: "Organisations",
        href: "/explore/enterprise/organisations",
      },
      { label: "Community", href: "/explore/community" },
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
    heading: "Enterprise",
    links: [
      { label: "Overview", href: "/enterprise" },
      { label: "Team training", href: "/enterprise/team-training" },
      {
        label: "Corporate mentorship",
        href: "/enterprise/corporate-mentorship",
      },
      { label: "Talk to sales", href: "/contactus" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Support", href: "/support" },
      { label: "Contact", href: "/contactus" },
      { label: "Blog", href: "/blog" },
      { label: "Pricing", href: "/pricing" },
      { label: "How it works", href: "/#how-it-works" },
      { label: "Become an expert", href: "/become-an-expert", external: true },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Terms of Service", href: "/terms" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Refund Policy", href: "/refund" },
    ],
  },
];

// Internal-linking band. A marketplace's value is its long-tail catalog, so
// these deep links are worth more here than another column of company pages.
const EXPERTISE_LINKS: FooterLink[] = [
  { label: "Technology", href: "/explore/experts?domain=Technology" },
  { label: "Business", href: "/explore/experts?domain=Business" },
  { label: "Creative Arts", href: "/explore/experts?domain=Creative Arts" },
  { label: "Education", href: "/explore/experts?domain=Education" },
  { label: "Health", href: "/explore/experts?domain=Health" },
  {
    label: "Personal Development",
    href: "/explore/experts?domain=Personal Development",
  },
];

const SOCIAL_LINKS = [
  {
    icon: XIcon,
    href: "https://twitter.com/familiarise",
    label: "X",
  },
  {
    icon: LinkedInIcon,
    href: "https://linkedin.com/company/familiarise",
    label: "LinkedIn",
  },
  {
    icon: InstagramIcon,
    href: "https://instagram.com/familiarise",
    label: "Instagram",
  },
  {
    icon: YoutubeIcon,
    href: "https://youtube.com/familiarise",
    label: "YouTube",
  },
  {
    icon: FacebookIcon,
    href: "https://facebook.com/familiarise",
    label: "Facebook",
  },
];

const Footer: React.FC = () => {
  const pathname = usePathname();
  const [email, setEmail] = useState("");
  const [waitlistStatus, setWaitlistStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");

  // Check if we're on the home page
  const isHomePage = pathname === "/";

  // Route list lives in lib/navigation/public-chrome.ts — it was duplicated
  // across Navbar/Footer/HeaderSpacer and had already drifted.
  if (isChromeHidden(pathname)) return null;

  // The heading says "Stay in the loop" and the copy promises a weekly email,
  // but the button still said "Join waitlist" — left over from the
  // waitlist→newsletter rework. The endpoint is unchanged; only the label was
  // stale.
  const subscribeButtonLabel = {
    idle: "Subscribe",
    loading: "Subscribing...",
    success: "Check your email",
    error: "Subscribe",
  }[waitlistStatus];

  const handleWaitlistSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || waitlistStatus === "loading") return;

    setWaitlistStatus("loading");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Tagged by surface so the admin list can tell where signups come from.
        body: JSON.stringify({ email, source: "FOOTER" }),
      });
      if (!res.ok) throw new Error("Failed");
      setEmail("");
      setWaitlistStatus("success");
    } catch {
      setWaitlistStatus("error");
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

      {/* Waitlist signup — every marketing page, merged with the footer */}
      <div className="relative z-10 border-b border-zinc-800">
        <div className="container mx-auto px-4 md:px-6 py-20 md:py-28">
          <div className="max-w-2xl mx-auto text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center mx-auto mb-6 shadow-lg">
              <MessageSquare className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-fluid-5xl font-bold tracking-tight text-white mb-4">
              Stay in the <span className="silver-text">loop</span>
            </h2>
            <p className="text-lg text-zinc-500 mb-8">
              Get expert tips, career advice, and exclusive offers delivered to
              your inbox weekly.
            </p>

            <form
              className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
              onSubmit={handleWaitlistSubmit}
            >
              <Input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-14 bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-600 rounded-xl focus:border-zinc-600 focus:ring-zinc-600"
              />
              <Button
                type="submit"
                size="lg"
                disabled={
                  waitlistStatus === "loading" || waitlistStatus === "success"
                }
                className="h-14 bg-white text-zinc-900 hover:bg-zinc-200 px-8 rounded-xl font-medium shrink-0"
              >
                {subscribeButtonLabel}
              </Button>
            </form>

            {waitlistStatus === "error" && (
              <p className="text-sm text-red-400 mt-2">
                Something went wrong. Please try again.
              </p>
            )}

            <p className="text-sm text-zinc-600 mt-4">
              No spam, unsubscribe anytime.{" "}
              <Link
                href="/privacy"
                className="underline hover:text-zinc-400 transition-colors"
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
              <div className="relative h-10 w-36">
                <Image
                  src={familiariseLogoWhite}
                  alt="Familiarise"
                  fill
                  className="object-contain object-left"
                  sizes="144px"
                />
              </div>
            </Link>
            <p className="text-zinc-400 text-sm leading-relaxed mb-6 max-w-xs">
              Connect with world-class experts for personalized mentorship,
              classes, and career guidance. Transform your career today.
            </p>

            {/* Social Links */}
            <div className="flex items-center gap-3">
              {SOCIAL_LINKS.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={social.label}
                  className="w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center transition-colors group"
                >
                  <social.icon className="w-4 h-4 text-zinc-400 group-hover:text-white transition-colors" />
                </a>
              ))}
            </div>
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
                      {link.external && <ArrowUpRight className="w-3 h-3" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Expertise band — deep links into the catalog */}
        <div className="mt-12 pt-8 border-t border-zinc-800">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-3">
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

      {/* Bottom Bar — legal lives in its own column above, so this carries
          only the copyright line. */}
      <div className="border-t border-zinc-800 relative z-10">
        <div className="container mx-auto px-4 md:px-6 py-6">
          <p className="text-sm text-zinc-500 text-center md:text-left">
            © {new Date().getFullYear()} Familiarise. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
