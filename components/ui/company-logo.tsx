"use client";

import { Building2 } from "lucide-react";
import { LogoBase } from "./logo-base";
import { lookupCompanyDomain } from "@/lib/data/known-companies";

// Re-export for backward compatibility
export { lookupCompanyDomain } from "@/lib/data/known-companies";

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
  const resolvedDomain = companyDomain || lookupCompanyDomain(companyName);

  return (
    <LogoBase
      domain={resolvedDomain}
      name={companyName}
      size={size}
      className={className}
      fallbackIcon={Building2}
    />
  );
}
