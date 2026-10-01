"use client";

/**
 * Loads one offering by plan id into the editor's event wrapper — shared by
 * the edit page and the Duplicate prefill (`new?from=<id>`, #1527 §7.2).
 */

import { useQuery } from "@tanstack/react-query";

import { OFFERING_MANIFESTS } from "./manifests";
import type { OfferingType } from "./manifest";

const PLAN_PATH: Record<OfferingType, (id: string) => string> = {
  consultation: (id) => `/api/plans/consultations/${id}`,
  subscription: (id) => `/api/plans/subscriptions/${id}`,
  webinar: (id) => `/api/plans/webinars/${id}`,
  class: (id) => `/api/plans/classes/${id}`,
};

interface InstanceRow {
  id?: string;
  status?: string | null;
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
    const scheduledAt =
      webinar?.appointment?.occurrences?.[0]?.startsAt ?? null;
    return {
      type,
      id,
      instanceId: webinar?.id,
      instanceStatus: webinar?.status ?? null,
      webinarPlan: { ...plan, scheduledAt },
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
    classPlan: plan,
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
    queryFn: async () => {
      const response = await fetch(PLAN_PATH[type](offeringId ?? ""));
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Failed to load ${type} plan (${response.status})`);
      }
      const body = (await response.json()) as {
        data?: Record<string, unknown>;
      };
      if (!body.data) return null;
      return wrapPlanAsEvent(type, body.data, instanceId);
    },
  });
}
