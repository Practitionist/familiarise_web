"use client";

/**
 * Loads one offering by plan id into the editor's event wrapper — shared by
 * the edit page and the Duplicate prefill (`new?from=<id>`, #1527 §7.2).
 */

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  DigitalProductAssetStatus,
  DigitalProductCategory,
  DigitalProductStatus,
} from "@prisma/client";

import { OFFERING_MANIFESTS } from "./manifests";
import type { OfferingType } from "./manifest";

const PLAN_PATH: Record<OfferingType, (id: string) => string> = {
  consultation: (id) => `/api/plans/consultations/${id}`,
  // The author also learns how many live buyers keep their current terms.
  subscription: (id) => `/api/plans/subscriptions/${id}?include=activeClients`,
  // The host-only editor reads: the public plan GET is CDN-cached.
  webinar: (id) => `/api/plans/webinars/${id}/editor`,
  class: (id) => `/api/plans/classes/${id}/editor`,
};

interface InstanceRow {
  id?: string;
  status?: string | null;
  maxParticipants?: number | null;
  schedulingPeriodStartsAt?: string | Date | null;
  appointment?: {
    occurrences?: Array<{ startsAt?: string | Date | null }>;
  } | null;
}

/**
 * The Webinar/Class row a group card stands for: the named batch, else the
 * plan's first. Its id is what the save PATCHes and its status decides
 * whether "Save draft" can apply (#1527 — publishing is one-way).
 */
function pickInstance(
  rows: InstanceRow[] | undefined,
  instanceId: string | null,
): InstanceRow | undefined {
  return rows?.find((row) => row.id === instanceId) ?? rows?.[0];
}

/** The form edits the instance's effective capacity: its override, else the plan's. */
function withEffectiveCapacity(
  plan: Record<string, unknown>,
  instance: InstanceRow | undefined,
): Record<string, unknown> {
  const override = instance?.maxParticipants;
  return typeof override === "number"
    ? { ...plan, maxParticipants: override }
    : plan;
}

/**
 * Adapters expect a planner-shaped event wrapper, not the bare plan row.
 * Class start date lives on the Class instance (`schedulingPeriodStartsAt`),
 * so it is lifted onto the wrapper the same way the planner list does.
 */
export function wrapPlanAsEvent(
  type: OfferingType,
  plan: Record<string, unknown>,
  instanceId: string | null = null,
): Record<string, unknown> {
  const id = String(plan.id ?? "");
  if (type === "consultation") {
    return { type, id, consultationPlan: plan };
  }
  if (type === "subscription") {
    return { type, id, subscriptionPlan: plan };
  }
  if (type === "webinar") {
    const webinar = pickInstance(
      plan.webinars as InstanceRow[] | undefined,
      instanceId,
    );
    // The plan row has no scheduledAt column; the first slot is the session.
    const startsAt = webinar?.appointment?.occurrences?.[0]?.startsAt ?? null;
    const scheduledAt =
      startsAt instanceof Date ? startsAt.toISOString() : startsAt;
    return {
      type,
      id,
      instanceId: webinar?.id,
      instanceStatus: webinar?.status ?? null,
      webinarPlan: { ...withEffectiveCapacity(plan, webinar), scheduledAt },
    };
  }
  const cls = pickInstance(
    plan.classes as InstanceRow[] | undefined,
    instanceId,
  );
  return {
    type,
    id,
    instanceId: cls?.id,
    instanceStatus: cls?.status ?? null,
    classPlan: withEffectiveCapacity(plan, cls),
    schedulingPeriodStartsAt: cls?.schedulingPeriodStartsAt ?? null,
  };
}

/**
 * Load the one offering by id. A paginated list lookup (plus
 * marketplaceVisibilityWhere on those list routes) 404'd valid plans that were
 * past page one or marked ORG_ONLY — the owner's own edit URL must not depend
 * on marketplace visibility or list pagination.
 */
export function useOfferingEvent(
  type: OfferingType,
  offeringId: string | null,
  instanceId: string | null = null,
) {
  return useQuery({
    queryKey: ["offering-edit", type, offeringId, instanceId],
    enabled: !!OFFERING_MANIFESTS[type] && !!offeringId,
    queryFn: () => loadOfferingEvent(type, offeringId ?? "", instanceId),
  });
}

/** One uncached read of the offering, wrapped for the editor; null when it is not there. */
export async function loadOfferingEvent(
  type: OfferingType,
  offeringId: string,
  instanceId: string | null,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(PLAN_PATH[type](offeringId), {
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load ${type} plan (${response.status})`);
  }
  const body = (await response.json()) as {
    data?: Record<string, unknown>;
  };
  if (!body.data) return null;
  return wrapPlanAsEvent(type, body.data, instanceId);
}

const ownedAssetSchema = z.object({
  id: z.string(),
  lineageId: z.string(),
  originalName: z.string(),
  /** The lineage's first name, which buyers see. */
  displayName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  order: z.number(),
  version: z.number(),
  status: z.nativeEnum(DigitalProductAssetStatus),
  rejectReason: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type OwnedProductAsset = z.infer<typeof ownedAssetSchema>;

const ownedProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  slug: z.string(),
  description: z.string(),
  category: z.nativeEnum(DigitalProductCategory),
  pricePaise: z.number(),
  status: z.nativeEnum(DigitalProductStatus),
  coverImagePath: z.string().nullable(),
  takenDownAt: z.string().nullable(),
  takedownReason: z.string().nullable(),
  assets: z.array(ownedAssetSchema),
  /** SUCCEEDED and REFUNDED sales; any keeps the product from being deleted. */
  purchaseCount: z.number(),
  /** Buyers who hold access now. */
  buyerCount: z.number(),
});
export type OwnedDigitalProduct = z.infer<typeof ownedProductSchema>;

export const digitalProductQueryKey = (productId: string) =>
  ["digital-product-edit", productId] as const;

/** The owner's full view of one product, files included; null when it is not theirs. */
export function useDigitalProduct(productId: string | null) {
  return useQuery({
    queryKey: digitalProductQueryKey(productId ?? ""),
    enabled: !!productId,
    queryFn: async (): Promise<OwnedDigitalProduct | null> => {
      const response = await fetch(
        `/api/digital-products/${encodeURIComponent(productId ?? "")}`,
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Failed to load product (${response.status})`);
      }
      const body = z
        .object({ data: ownedProductSchema })
        .safeParse(await response.json());
      return body.success ? body.data.data : null;
    },
  });
}
