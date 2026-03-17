"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";

interface CompanyLogoProps {
  companyDomain?: string;
  companyName: string;
  size?: number;
  className?: string;
}

/**
 * Renders a company logo from Logo.dev when companyDomain is available.
 * Falls back to a colored circle with the company's first letter.
 */
export function CompanyLogo({
  companyDomain,
  companyName,
  size = 40,
  className = "",
}: CompanyLogoProps) {
  const [imgError, setImgError] = useState(false);

  if (companyDomain && !imgError) {
    return (
      <div
        className={`flex-shrink-0 rounded-lg overflow-hidden bg-white border ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={`https://img.logo.dev/${companyDomain}?token=pk_a]3IhKKPSG6ibd40IJtZlA&size=${size * 2}&format=png`}
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
  // Deterministic color from company name
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
