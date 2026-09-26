"use client";

import { useParams } from "next/navigation";
import { useMemo } from "react";

import { useBreadcrumbOverride } from "@/components/dashboard/breadcrumb-override";

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
  listingHref: string;
}

export interface DashboardBreadcrumbsInput {
  pathname: string;
  basePath: string;
  pageLabels: Record<string, string>;
  /** Segments that group routes without a page of their own (never linked). */
  pathlessSegments?: ReadonlySet<string>;
  /** Consultant only, until the Offerings list route exists (#1527 b). */
  offeringsConfig?: OfferingsCrumbConfig;
}

// Opaque record ids (cuid / uuid) in nested routes carry no meaning as crumbs.
const looksLikeRecordId = (segment: string) =>
  /^[a-z0-9]{20,}$/i.test(segment) ||
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
  pageLabels: Record<string, string>;
  pathlessSegments: ReadonlySet<string> | undefined;
  paramValues: ReadonlySet<string>;
}

function resolveSegmentCrumb(ctx: Readonly<SegmentCrumbCtx>): Crumb | null {
  const { seg, acc, overrideLabel, pageLabels } = ctx;
  if (looksLikeRecordId(seg)) {
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
    // Offerings have no list route yet; the planner is where they live.
    return { label, href: ctx.offeringsListingHref };
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
      ? `${basePath}/${offeringsConfig.listingHref}`
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
