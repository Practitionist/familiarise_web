"use client";

import { useState } from "react";
import Image from "next/image";
import { cn } from "@/utils/tailwind";
import { nameInitials } from "@/lib/home/landing-content";

export function LandingPortrait({
  name,
  src,
  className,
  sizes = "(max-width: 640px) 80vw, 280px",
}: {
  name: string;
  src?: string;
  className?: string;
  sizes?: string;
}) {
  const [failedSource, setFailedSource] = useState<string>();

  return (
    <div
      className={cn(
        "relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-[#eeeee8] text-zinc-700",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="text-5xl font-medium tracking-[-0.06em]"
      >
        {nameInitials(name)}
      </span>
      {src && failedSource !== src && (
        <Image
          src={src}
          alt={name}
          fill
          sizes={sizes}
          className="object-cover"
          onError={() => setFailedSource(src)}
        />
      )}
    </div>
  );
}
