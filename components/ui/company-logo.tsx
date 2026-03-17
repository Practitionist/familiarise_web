"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";

// Well-known company name → domain for auto-detection
const KNOWN_COMPANIES: Record<string, string> = {
  google: "google.com",
  microsoft: "microsoft.com",
  amazon: "amazon.com",
  meta: "meta.com",
  facebook: "meta.com",
  apple: "apple.com",
  netflix: "netflix.com",
  salesforce: "salesforce.com",
  oracle: "oracle.com",
  ibm: "ibm.com",
  accenture: "accenture.com",
  deloitte: "deloitte.com",
  mckinsey: "mckinsey.com",
  "goldman sachs": "goldmansachs.com",
  "jp morgan": "jpmorgan.com",
  jpmorgan: "jpmorgan.com",
  stripe: "stripe.com",
  uber: "uber.com",
  airbnb: "airbnb.com",
  spotify: "spotify.com",
  adobe: "adobe.com",
  cisco: "cisco.com",
  vmware: "vmware.com",
  snowflake: "snowflake.com",
  databricks: "databricks.com",
  palantir: "palantir.com",
  coinbase: "coinbase.com",
  tesla: "tesla.com",
  nvidia: "nvidia.com",
  intel: "intel.com",
  samsung: "samsung.com",
  twitter: "x.com",
  x: "x.com",
  linkedin: "linkedin.com",
  github: "github.com",
  atlassian: "atlassian.com",
  slack: "slack.com",
  zoom: "zoom.us",
  shopify: "shopify.com",
  twilio: "twilio.com",
  square: "squareup.com",
  block: "block.xyz",
  paypal: "paypal.com",
  razorpay: "razorpay.com",
  flipkart: "flipkart.com",
  swiggy: "swiggy.com",
  zomato: "zomato.com",
  infosys: "infosys.com",
  tcs: "tcs.com",
  "tata consultancy services": "tcs.com",
  wipro: "wipro.com",
  hcl: "hcltech.com",
  reliance: "ril.com",
  jio: "jio.com",
  paytm: "paytm.com",
  phonepe: "phonepe.com",
  byju: "byjus.com",
  "byju's": "byjus.com",
  ola: "olacabs.com",
  meesho: "meesho.io",
  cred: "cred.club",
  dream11: "dream11.com",
  zerodha: "zerodha.com",
  groww: "groww.in",
  unacademy: "unacademy.com",
  notion: "notion.so",
  figma: "figma.com",
  vercel: "vercel.com",
  netlify: "netlify.com",
  supabase: "supabase.com",
  mongodb: "mongodb.com",
  elastic: "elastic.co",
  datadog: "datadoghq.com",
  cloudflare: "cloudflare.com",
  aws: "aws.amazon.com",
  "amazon web services": "aws.amazon.com",
  "google cloud": "cloud.google.com",
  azure: "azure.microsoft.com",
  "digital ocean": "digitalocean.com",
  digitalocean: "digitalocean.com",
  heroku: "heroku.com",
  redhat: "redhat.com",
  "red hat": "redhat.com",
  docker: "docker.com",
  hashicorp: "hashicorp.com",
  jetbrains: "jetbrains.com",
  postman: "postman.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/** Resolve a company name to its website domain, or null if unknown. */
export function lookupCompanyDomain(companyName: string): string | null {
  return KNOWN_COMPANIES[companyName.trim().toLowerCase()] || null;
}

interface CompanyLogoProps {
  companyDomain?: string;
  companyName: string;
  size?: number;
  className?: string;
}

/**
 * Renders a company logo from Logo.dev.
 * Auto-detects domain from company name for ~90 well-known companies.
 * Falls back to a colored circle with the company's first letter.
 */
export function CompanyLogo({
  companyDomain,
  companyName,
  size = 40,
  className = "",
}: CompanyLogoProps) {
  const [imgError, setImgError] = useState(false);

  // Use explicit domain, or auto-detect from company name
  const resolvedDomain = companyDomain || lookupCompanyDomain(companyName);

  if (resolvedDomain && !imgError) {
    return (
      <div
        className={`flex-shrink-0 rounded-lg overflow-hidden bg-white border ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={`https://img.logo.dev/${resolvedDomain}?token=pk_a]3IhKKPSG6ibd40IJtZlA&size=${size * 2}&format=png`}
          alt={`${companyName} logo`}
          width={size}
          height={size}
          className="object-contain w-full h-full"
          onError={() => setImgError(true)}
          loading="lazy"
        />
      </div>
    );
  }

  // Fallback: colored circle with company initial
  const initial = companyName.charAt(0).toUpperCase();
  const colors = [
    "bg-blue-100 text-blue-700",
    "bg-emerald-100 text-emerald-700",
    "bg-purple-100 text-purple-700",
    "bg-amber-100 text-amber-700",
    "bg-rose-100 text-rose-700",
    "bg-cyan-100 text-cyan-700",
    "bg-indigo-100 text-indigo-700",
    "bg-orange-100 text-orange-700",
  ];
  const colorIndex =
    companyName
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  const colorClass = colors[colorIndex];

  return (
    <div
      className={`flex-shrink-0 rounded-lg flex items-center justify-center font-semibold ${colorClass} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initial || <Building2 style={{ width: size * 0.5, height: size * 0.5 }} />}
    </div>
  );
}
