"use client";

import React, { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FaFacebook,
  FaInstagram,
  FaYoutube,
  FaLinkedin,
  FaTwitter,
} from "react-icons/fa";
import { ArrowUpRight, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import familiariseLogoWhite from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_white.avif";

interface FooterLink {
  label: string;
  href: string;
}

const FOOTER_LINKS: Record<string, FooterLink[]> = {
  expertise: [
    { label: "Technology", href: "/explore/experts?category=technology" },
    { label: "Business", href: "/explore/experts?category=business" },
    { label: "Design", href: "/explore/experts?category=design" },
    { label: "Marketing", href: "/explore/experts?category=marketing" },
    { label: "Education", href: "/explore/experts?category=education" },
  ],
  company: [
    { label: "About", href: "/about" },
    { label: "Careers", href: "/careers" },
    { label: "Press", href: "/press" },
    { label: "Contact", href: "/contactus" },
    { label: "Blog", href: "/blog" },
  ],
  resources: [
    { label: "Help Center", href: "/help" },
    { label: "Community", href: "/explore/community" },
    { label: "Become an Expert", href: "/form/onboarding" },
    { label: "Pricing", href: "/pricing" },
  ],
  legal: [
    { label: "Terms of Service", href: "/terms" },
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Refund Policy", href: "/refund" },
    { label: "Cookie Policy", href: "/cookies" },
  ],
};

const SOCIAL_LINKS = [
  {
    icon: FaTwitter,
    href: "https://twitter.com/familiarise",
    label: "Twitter",
  },
  {
    icon: FaLinkedin,
    href: "https://linkedin.com/company/familiarise",
    label: "LinkedIn",
  },
  {
    icon: FaInstagram,
    href: "https://instagram.com/familiarise",
    label: "Instagram",
  },
  {
    icon: FaYoutube,
    href: "https://youtube.com/familiarise",
    label: "YouTube",
  },
  {
    icon: FaFacebook,
    href: "https://facebook.com/familiarise",
    label: "Facebook",
  },
];

const Footer: React.FC = () => {
  const pathname = usePathname();
  const [email, setEmail] = useState("");

  // Check if we're on the home page
  const isHomePage = pathname === "/";

  // Routes where footer should be hidden
  const excludeFooter =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/form/") ||
    pathname.startsWith("/checkout/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/meetings/");

  if (excludeFooter) return null;

  const handleNewsletterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log("Newsletter signup:", email);
    setEmail("");
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

      {/* Newsletter Section - Only on home page, merged with footer */}
      {isHomePage && (
        <div className="relative z-10 border-b border-zinc-800">
          <div className="container mx-auto px-4 md:px-6 py-20 md:py-28">
            <div className="max-w-2xl mx-auto text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center mx-auto mb-6 shadow-lg">
                <MessageSquare className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-4">
                Stay in the <span className="silver-text">loop</span>
              </h2>
              <p className="text-lg text-zinc-500 mb-8">
                Get expert tips, career advice, and exclusive offers delivered
                to your inbox weekly.
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
                  className="h-14 bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-600 rounded-xl focus:border-zinc-600 focus:ring-zinc-600"
                />
                <Button
                  type="submit"
                  size="lg"
                  className="h-14 bg-white text-zinc-900 hover:bg-zinc-200 px-8 rounded-xl font-medium shrink-0"
                >
                  Subscribe
                </Button>
              </form>

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
      )}

      {/* Main Footer Content */}
      <div className="container mx-auto px-4 md:px-6 py-16 md:py-20 relative z-10">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-8 lg:gap-12">
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

          {/* Expertise Column */}
          <div>
            <h3 className="font-semibold text-white mb-4">Expertise</h3>
            <ul className="space-y-3">
              {FOOTER_LINKS.expertise.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-zinc-400 hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company Column */}
          <div>
            <h3 className="font-semibold text-white mb-4">Company</h3>
            <ul className="space-y-3">
              {FOOTER_LINKS.company.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-zinc-400 hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources Column */}
          <div>
            <h3 className="font-semibold text-white mb-4">Resources</h3>
            <ul className="space-y-3">
              {FOOTER_LINKS.resources.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-zinc-400 hover:text-white transition-colors inline-flex items-center gap-1"
                  >
                    {link.label}
                    {link.label === "Become an Expert" && (
                      <ArrowUpRight className="w-3 h-3" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal Column */}
          <div>
            <h3 className="font-semibold text-white mb-4">Legal</h3>
            <ul className="space-y-3">
              {FOOTER_LINKS.legal.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-zinc-400 hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="border-t border-zinc-800 relative z-10">
        <div className="container mx-auto px-4 md:px-6 py-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-sm text-zinc-500">
              © {new Date().getFullYear()} Familiarise. All rights reserved.
            </p>
            <div className="flex items-center gap-6">
              <Link
                href="/terms"
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Terms
              </Link>
              <Link
                href="/privacy"
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Privacy
              </Link>
              <Link
                href="/refund"
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Refunds
              </Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
