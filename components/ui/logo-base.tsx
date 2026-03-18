"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN;

const FALLBACK_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-purple-100 text-purple-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700",
  "bg-orange-100 text-orange-700",
];

function getDeterministicColor(name: string): string {
  const index =
    name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) %
    FALLBACK_COLORS.length;
  return FALLBACK_COLORS[index];
}

interface LogoBaseProps {
  domain?: string | null;
  name: string;
  size?: number;
  className?: string;
  fallbackIcon?: React.ElementType;
}

export function LogoBase({
  domain,
  name,
  size = 40,
  className = "",
  fallbackIcon: FallbackIcon = Building2,
}: LogoBaseProps) {
  const [imgError, setImgError] = useState(false);

  if (domain && !imgError && LOGO_DEV_TOKEN) {
    return (
      <div
        className={`flex-shrink-0 rounded-lg overflow-hidden bg-white border ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={`https://img.logo.dev/${domain}?token=${LOGO_DEV_TOKEN}&size=${size * 2}&format=png`}
          alt={`${name} logo`}
          width={size}
          height={size}
          className="object-contain w-full h-full"
          onError={() => setImgError(true)}
          loading="lazy"
        />
      </div>
    );
  }

  const initial = name.charAt(0).toUpperCase();
  const colorClass = getDeterministicColor(name);

  return (
    <div
      className={`flex-shrink-0 rounded-lg flex items-center justify-center font-semibold ${colorClass} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initial || (
        <FallbackIcon style={{ width: size * 0.5, height: size * 0.5 }} />
      )}
    </div>
  );
}
