"use client";

import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Building2,
  Clock,
  LifeBuoy,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
} from "lucide-react";
import { ContactForm } from "./ContactForm";
import {
  COMPANY_INFO,
  PAGE_META,
  BUSINESS_HOURS,
  SUPPORT_LINKS,
  getMailtoLink,
  getTelLink,
} from "../constants";

export default function ContactUsPage() {
  return (
    <main className="min-h-screen w-full bg-background">
      {/* Dark Hero */}
      <section className="relative overflow-hidden bg-zinc-950 text-white pt-32 pb-20">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-[380px] w-[720px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(255,255,255,0.08),transparent)]"
        />

        <div className="container relative z-10 mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/80 px-4 py-1.5 text-sm text-zinc-300 backdrop-blur-sm">
            <MessageSquare className="h-4 w-4 text-zinc-300" aria-hidden />
            <span>{PAGE_META.contact.title}</span>
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl mb-4 font-bold tracking-tight">
            Get in touch with{" "}
            <span className="silver-text">our team</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg leading-relaxed text-zinc-400">
            {PAGE_META.contact.description} We respond within 24–48 hours on
            business days.
          </p>
        </div>
      </section>

      {/* Main 2-Column Content */}
      <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 md:py-24 lg:px-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* Left Column: Structured Contact Channel Cards */}
          <div className="space-y-5 lg:col-span-5">
            {/* Support Card */}
            <div className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1">
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
                  <LifeBuoy className="h-5 w-5 text-foreground" aria-hidden />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground">Support</h2>
                  <p className="text-xs text-muted-foreground">
                    Bookings, billing &amp; technical help
                  </p>
                </div>
              </div>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p className="flex items-center gap-2">
                  <Mail className="h-4 w-4 shrink-0 text-foreground" />
                  <a
                    href={getMailtoLink(COMPANY_INFO.supportEmail)}
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    {COMPANY_INFO.supportEmail}
                  </a>
                </p>
                {COMPANY_INFO.phone ? (
                  <p className="flex items-center gap-2">
                    <Phone className="h-4 w-4 shrink-0 text-foreground" />
                    <a
                      href={getTelLink()}
                      className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                    >
                      {COMPANY_INFO.phone}
                    </a>
                  </p>
                ) : null}
              </div>
            </div>

            {/* Enterprise & Partnerships Card */}
            <div className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1">
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
                  <Building2 className="h-5 w-5 text-foreground" aria-hidden />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground">
                    Enterprise &amp; Partnerships
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Team training, sponsored seats &amp; agencies
                  </p>
                </div>
              </div>
              <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
                Looking to sponsor sessions for your team or host your
                organisation&apos;s experts on {COMPANY_INFO.name}?
              </p>
              <p className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 shrink-0 text-foreground" />
                <a
                  href={getMailtoLink(COMPANY_INFO.email)}
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  {COMPANY_INFO.email}
                </a>
              </p>
            </div>

            {/* Office & Hours Card */}
            <div className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1">
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
                  <Clock className="h-5 w-5 text-foreground" aria-hidden />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground">
                    Office &amp; Hours
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Indian Standard Time (IST)
                  </p>
                </div>
              </div>
              <div className="space-y-1.5 text-sm text-muted-foreground">
                <p>{BUSINESS_HOURS.weekdays}</p>
                <p>{BUSINESS_HOURS.saturday}</p>
                <p>{BUSINESS_HOURS.sunday}</p>
                <p className="flex items-center gap-2 pt-2 text-foreground">
                  <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>{COMPANY_INFO.address}</span>
                </p>
              </div>
            </div>

            {/* Self-Serve Help Resources */}
            <div className="rounded-2xl border border-border bg-muted/50 p-6">
              <h3 className="text-sm font-semibold text-foreground">
                Quick self-serve answers
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Browse our documentation and policies for immediate answers:
              </p>
              <ul className="mt-3 space-y-2">
                {SUPPORT_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="group inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      <span>{link.label}</span>
                      <ArrowUpRight
                        className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Right Column: Contact Form Card */}
          <div className="lg:col-span-7">
            <div className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1 md:p-8">
              <div className="mb-6">
                <h2 className="text-fluid-2xl font-bold tracking-tight text-foreground">
                  Send us a message
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Fill out the form below and we&apos;ll get back to you as soon
                  as possible.
                </p>
              </div>
              {/* Suspense boundary: ContactForm reads ?category= for
                  deep-links from /support articles. */}
              <Suspense>
                <ContactForm />
              </Suspense>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
