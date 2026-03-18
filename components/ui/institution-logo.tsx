"use client";

import { GraduationCap } from "lucide-react";
import { LogoBase } from "./logo-base";
import { lookupInstitutionDomain } from "@/lib/data/known-institutions";

// Re-export for convenience
export { lookupInstitutionDomain } from "@/lib/data/known-institutions";

interface InstitutionLogoProps {
  institutionDomain?: string;
  institutionName: string;
  size?: number;
  className?: string;
}

/**
 * Renders an institution logo from Logo.dev.
 * Auto-detects domain from institution name for ~120 well-known institutions.
 * Falls back to a colored circle with the institution's first letter.
 */
export function InstitutionLogo({
  institutionDomain,
  institutionName,
  size = 40,
  className = "",
}: InstitutionLogoProps) {
  const resolvedDomain =
    institutionDomain || lookupInstitutionDomain(institutionName);

  return (
    <LogoBase
      domain={resolvedDomain}
      name={institutionName}
      size={size}
      className={className}
      fallbackIcon={GraduationCap}
    />
  );
}
