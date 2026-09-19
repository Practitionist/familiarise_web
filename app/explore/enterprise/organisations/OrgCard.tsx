"use client";

import { BadgeCheck, Building2, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { OrganisationListItem } from "@/lib/explore/organisation-types";
import {
  ORG_DIRECTORY_TYPE_LABEL,
  ORG_PUBLIC_CAPABILITY_LABEL,
  ORG_SIZE_BUCKET_LABEL,
} from "@/lib/labels/org-labels";

export default function OrgCard({
  org,
}: Readonly<{ org: OrganisationListItem }>) {
  // Type is the primary badge; capability is secondary supporting detail. Both
  // are neutral taxonomy, so both render monochrome — filled for identity,
  // muted for the supporting fact.
  const typeLabel = org.directoryType
    ? ORG_DIRECTORY_TYPE_LABEL[org.directoryType]
    : null;
  const capabilityLabel = ORG_PUBLIC_CAPABILITY_LABEL[org.capability];

  return (
    <Link
      href={`/explore/enterprise/organisations/${org.slug}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:shadow-lg"
    >
      {/* Bannerless by default: the old always-rendered h-24 gradient read
          as a broken/unbranded slot for every org without a cover. Only
          render the cover slot when a real banner image exists; otherwise
          a hairline keeps the card edge clean and the logo row sits inline
          (no -mt-10 overlap). */}
      {org.bannerImage ? (
        <div className="relative h-24 overflow-hidden bg-muted">
          <Image
            src={org.bannerImage}
            alt=""
            fill
            sizes="(min-width: 1280px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover opacity-60"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
        </div>
      ) : (
        <div className="h-1.5 bg-muted" aria-hidden />
      )}

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div
          className={`flex items-center gap-3 ${org.bannerImage ? "relative -mt-10" : ""}`}
        >
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-card bg-card shadow-md">
            {org.logo ? (
              <Image
                src={org.logo}
                alt={org.name}
                width={56}
                height={56}
                className="object-contain"
              />
            ) : (
              <Building2 className="h-7 w-7 text-muted-foreground/70" />
            )}
          </div>
          {/* pt-8 only clears the -mt-10 logo overlap when a banner exists. */}
          <div className={`min-w-0 ${org.bannerImage ? "pt-8" : ""}`}>
            <h3 className="flex items-center gap-1 truncate font-bold text-foreground transition-colors group-hover:text-muted-foreground">
              <span className="truncate" title={org.name}>
                {org.name}
              </span>
              {org.isVerified && (
                <BadgeCheck
                  className="h-4 w-4 flex-shrink-0 text-foreground"
                  aria-label="Verified organisation"
                />
              )}
            </h3>
            {org.industry && (
              <p className="truncate text-xs text-muted-foreground">
                {org.industry}
              </p>
            )}
          </div>
        </div>

        {org.description && (
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {org.description}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
          {typeLabel && (
            <Badge
              variant="outline"
              className="border-transparent bg-primary px-2 py-0.5 text-[10px] text-primary-foreground"
            >
              {typeLabel}
            </Badge>
          )}
          {capabilityLabel && (
            <Badge
              variant="outline"
              className="border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {capabilityLabel}
            </Badge>
          )}
          {org.sizeBucket && (
            <Badge
              variant="outline"
              className="border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {ORG_SIZE_BUCKET_LABEL[org.sizeBucket]}
            </Badge>
          )}
        </div>

        {/* Expert count is only meaningful for orgs that host experts. */}
        {(org.capability === "host" || org.capability === "hybrid") && (
          <div className="flex items-center gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span>
              {org.expertCount} expert{org.expertCount !== 1 ? "s" : ""}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

export function OrgCardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="h-1.5 bg-muted" />
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-3">
          <div className="h-14 w-14 rounded-xl bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="h-4 w-28 rounded bg-muted" />
            <div className="h-3 w-20 rounded bg-muted" />
          </div>
        </div>
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-3/4 rounded bg-muted" />
        <div className="flex gap-1.5 pt-2">
          <div className="h-5 w-20 rounded-full bg-muted" />
          <div className="h-5 w-16 rounded-full bg-muted" />
        </div>
      </div>
    </div>
  );
}
