"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import type { OfferingType } from "@/components/offerings/editor/manifest";

/**
 * Org authoring uses the same editor as personal authoring.
 *
 * It previously had its own reduced surface that dropped every ADR-24 content
 * field on the floor, so an org-authored offering was structurally thinner than
 * the identical personal one. Only the WRITE differs — the org endpoint stamps
 * the organization and writes an audit log — so only the write is overridden.
 */
export function NewOrgOfferingClient({
  orgId,
  type,
}: Readonly<{ orgId: string; type: OfferingType }>) {
  const search = useSearchParams();
  // Which expert delivers it. The catalog picks this before routing here.
  const expertId = search.get("expertId") ?? "";

  const returnHref = `/dashboard/organization/${orgId}/catalog`;

  return (
    <>
      <DashboardContent className="content-flush-bottom flex flex-1 flex-col">
        <DashboardErrorBoundary>
          {expertId ? (
            <OfferingEditorContainer
              type={type}
              consultantId={expertId}
              returnHref={returnHref}
              onSave={async (values) => {
                const response = await fetch(
                  `/api/organizations/${orgId}/catalog`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      ...values,
                      kind: type.toUpperCase(),
                      consultantProfileId: expertId,
                      // The endpoint takes paise; the form edits rupees, same
                      // as every other price field in the product.
                      pricePaise: Math.round(Number(values.price ?? 0) * 100),
                    }),
                  },
                );
                if (!response.ok) {
                  const body = await response.json().catch(() => ({}));
                  throw new Error(body.error ?? "Failed to save offering");
                }
              }}
            />
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Pick the expert who will deliver this offering first.
              </p>
              <Link href={returnHref} className="text-sm underline">
                Back to catalog
              </Link>
            </div>
          )}
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
