"use client";

import { useParams } from "next/navigation";
import { useMemo } from "react";

import { useBreadcrumbOverride } from "@/components/dashboard/breadcrumb-override";
import { parseCaseKey } from "@/lib/support/case-key";

/**
 * One breadcrumb hook for every dashboard shell (#1527), driven by per-tree
 * page labels. Parent crumbs link back; opaque record ids are dropped or
 * replaced by the page's override label (e.g. the appointment title).
 */

export interface Crumb {
  label: string;
  href?: string;
}

export interface OfferingsCrumbConfig {
  typeSegments: ReadonlySet<string>;
  /** The list for an editor's type segment, relative to `basePath`. */
  listingPath: (typeSegment: string | undefined) => string;
  /** The `offerings` crumb's label for a type; the page label when omitted. */
  rootLabel?: (typeSegment: string | undefined) => string;
}

export interface DashboardBreadcrumbsInput {
  pathname: string;
  basePath: string;
  pageLabels: Record<string, string>;
  /** Segments that group routes without a page of their own (never linked). */
  pathlessSegments?: ReadonlySet<string>;
  /** Consultant only: where an editor's `offerings/<type>` crumbs point. */
  offeringsConfig?: OfferingsCrumbConfig;
}

// Opaque record IDs are replaced by the page’s human label or omitted.
const looksLikeRecordId = (segment: string) =>
  parseCaseKey(segment) !== null ||
  /^[a-z0-9]{20,}$/i.test(segment) ||
  // An unscheduled class/webinar travels as `unscheduled-<kind>-<cuid>`.
  /^unscheduled-(class|webinar)-[a-z0-9]{20,}$/i.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    segment,
  );

/** Title-case a segment no label map knows ("purchase-orders" → "Purchase Orders"). */
function prettifySegment(segment: string): string {
  return segment
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface SegmentCrumbCtx {
  seg: string;
  acc: string;
  overrideLabel: string | null;
  onOfferings: boolean;
  offeringsConfig: OfferingsCrumbConfig | undefined;
  offeringsListingHref: string;
  offeringsType: string | undefined;
  pageLabels: Record<string, string>;
  pathlessSegments: ReadonlySet<string> | undefined;
  paramValues: ReadonlySet<string>;
}

function resolveSegmentCrumb(ctx: Readonly<SegmentCrumbCtx>): Crumb | null {
  const { seg, acc, overrideLabel, pageLabels } = ctx;
  if (acc.endsWith("/support/requests")) {
    return {
      label: "Support cases",
      href: acc.slice(0, -"/requests".length),
    };
  }
  if (
    looksLikeRecordId(seg) ||
    (ctx.paramValues.has(seg) && acc.includes("/support/evidence/"))
  ) {
    // The record's human name belongs where its id was.
    return overrideLabel ? { label: overrideLabel, href: acc } : null;
  }
  const label = pageLabels[seg] ?? prettifySegment(seg);
  const { offeringsConfig } = ctx;
  if (
    offeringsConfig &&
    (seg === "offerings" ||
      (ctx.onOfferings && offeringsConfig.typeSegments.has(seg)))
  ) {
    // A type segment has no page of its own; the list is where it lives.
    return {
      label:
        seg === "offerings" && offeringsConfig.rootLabel
          ? offeringsConfig.rootLabel(ctx.offeringsType)
          : label,
      href: ctx.offeringsListingHref,
    };
  }
  // A segment bound to a dynamic param is never a URL of its own.
  const navigable =
    !ctx.pathlessSegments?.has(seg) && !ctx.paramValues.has(seg);
  return navigable ? { label, href: acc } : { label };
}

export function useDashboardBreadcrumbs(
  input: Readonly<DashboardBreadcrumbsInput>,
): Crumb[] {
  const { pathname, basePath, pageLabels, pathlessSegments, offeringsConfig } =
    input;
  const { overrideLabel } = useBreadcrumbOverride();
  const routeParams = useParams();
  return useMemo(() => {
    const paramValues = new Set<string>();
    for (const value of Object.values(routeParams ?? {})) {
      for (const part of Array.isArray(value) ? value : [value]) {
        if (part) paramValues.add(part);
      }
    }
    const parts = pathname.startsWith(basePath)
      ? pathname.slice(basePath.length).split("/").filter(Boolean)
      : [];
    const onOfferings = !!offeringsConfig && parts[0] === "offerings";
    const offeringsListingHref = offeringsConfig
      ? `${basePath}/${offeringsConfig.listingPath(parts[1])}`
      : basePath;

    const crumbs: Crumb[] = [];
    let acc = basePath;
    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      const crumb = resolveSegmentCrumb({
        seg,
        acc,
        overrideLabel,
        onOfferings,
        offeringsConfig,
        offeringsListingHref,
        offeringsType: parts[1],
        pageLabels,
        pathlessSegments,
        paramValues,
      });
      if (crumb) crumbs.push(crumb);
    }
    // The current page is plain text; a trailing link survives only when the
    // last visible crumb is a parent (its record-id child was stripped).
    return crumbs.map((crumb, index) =>
      index === crumbs.length - 1 && crumb.href === pathname
        ? { label: crumb.label }
        : crumb,
    );
  }, [
    pathname,
    basePath,
    overrideLabel,
    pageLabels,
    pathlessSegments,
    offeringsConfig,
    routeParams,
  ]);
}
