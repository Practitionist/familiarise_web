"use client";

/**
 * Binds a manifest to an adapter and renders a working editor for any of the
 * four offering types.
 *
 * There is one of these, not four. The bespoke sections each type needs — the
 * FAQ editor, the class curriculum, the subscription roadmap — arrive as slots,
 * so adding a type means a manifest and an adapter, never another dialog.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "@/components/ui/use-toast";
import * as Sentry from "@sentry/nextjs";
import { FaqEditor } from "@/components/planner/components/form-fields/FaqEditor";
import { ContentItemsEditor } from "./ContentItemsEditor";
import { CollaboratorsTab } from "@/components/collaborators/CollaboratorsTab";
import { OfferingEditor } from "./OfferingEditor";
import { WaitingCountProvider } from "./waiting-count";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateOfferingQueries } from "@/components/planner/hooks/usePlanner";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { publicOfferingHref } from "@/components/offerings/list/offering-rows";
import {
  fetchOfferingStats,
  offeringStatKey,
  offeringStatsQueryKey,
} from "@/lib/offerings/stats";
import {
  OFFERING_ADAPTERS,
  classStartEdited,
  duplicateFormValues,
  type OfferingSaveContext,
} from "./adapters";
import { OFFERING_MANIFESTS, TRIAL_FIELD_NAMES } from "./manifests";
import { OfferingMaterials } from "./OfferingMaterials";
import {
  commitPlanImage,
  type StagedPlanImage,
} from "@/components/plans/PlanImageUploader";
import type { OfferingManifest, OfferingType } from "./manifest";
import {
  applySponsorPricingHintToManifest,
  resolveSponsorPricingHint,
} from "./sponsor-pricing-hint";
import { useSession } from "@/lib/auth-client";
import { activeClientsNotice } from "@/lib/booking/entitlement";
import { activeClientsOf, withPricingNotice } from "./sold-terms-notice";
import { sellHomeHref } from "@/lib/dashboard/sell-pages";
import type { AvailabilityEvent } from "@/lib/scheduling/use-availability-window";
import { SessionHostProvider } from "./session-time-field";
import {
  feasibilityRefusalOf,
  feasibilityWarningsOf,
} from "./feasibility-feedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isExpectedRefusal } from "@/lib/errors/client-refusal";

interface OfferingEditorContainerProps {
  type: OfferingType;
  consultantId: string;
  /** The planner event being edited, or undefined when creating. */
  initialEvent?: unknown;
  /** #1527 Duplicate — a loaded offering to copy into a new, unsaved one. */
  duplicateOf?: unknown;
  /** Extra bespoke sections, keyed by the manifest's `slot`. */
  extraSlots?: Record<string, React.ReactNode>;
  /** Where to go once saved. Defaults to the Sell page listing this type. */
  returnHref?: string;
  /**
   * Overrides the adapter's save. The org catalog posts to its own endpoint
   * (which also stamps the organization and writes an audit log), so it supplies
   * its own writer rather than the whole editor being duplicated for org use.
   */
  onSave?: (
    values: Record<string, unknown>,
    opts: { publish: boolean },
  ) => Promise<void>;
}

/**
 * #1527 Q4 — the badge reads the real status: the plan's own column for 1:1
 * and subscription, the loaded instance's for webinar and class.
 */
function editorStatus(
  plan: Record<string, unknown> | undefined,
  planId: string | undefined,
  ctx: OfferingSaveContext,
): "DRAFT" | "PUBLISHED" | null {
  if (plan?.status === "DRAFT" || plan?.status === "PUBLISHED") {
    return plan.status;
  }
  if (ctx.instanceStatus === "DRAFT") return "DRAFT";
  return planId ? "PUBLISHED" : null;
}

/** The org catalog's writer does not persist a trial; don't offer one there. */
function withoutTrial(manifest: OfferingManifest): OfferingManifest {
  return {
    ...manifest,
    sections: manifest.sections.filter((section) =>
      section.fields.every((f) => !TRIAL_FIELD_NAMES.includes(f.name)),
    ),
  };
}

/** #1527 Q4 — say only what the save actually did for this type. */
function savedToast({
  publish,
  hasRealDraft,
  wasPublished,
}: {
  publish: boolean;
  hasRealDraft: boolean;
  wasPublished: boolean;
}): { title: string; description?: string } {
  if (publish) {
    return {
      title: "Offering published",
      description: "It's now visible to buyers.",
    };
  }
  if (!hasRealDraft) return { title: "Offering saved" };
  if (wasPublished) {
    return {
      title: "Offering unpublished",
      description:
        "Buyers can no longer find or book it. Existing bookings are unaffected.",
    };
  }
  return {
    title: "Draft saved",
    description: "Only you can see this until you publish it.",
  };
}

export function OfferingEditorContainer({
  type,
  consultantId,
  initialEvent,
  duplicateOf,
  extraSlots,
  returnHref,
  onSave,
}: Readonly<OfferingEditorContainerProps>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const adapter = OFFERING_ADAPTERS[type];
  const manifest = OFFERING_MANIFESTS[type];
  // Per-action, so only the pressed button spins.
  const [savingAction, setSavingAction] = React.useState<
    "draft" | "publish" | null
  >(null);
  const [stagedImage, setStagedImage] = React.useState<StagedPlanImage | null>(
    null,
  );

  const existingPlan = initialEvent ? adapter.planOf(initialEvent) : undefined;
  const copySource = duplicateOf ? adapter.planOf(duplicateOf) : undefined;
  const saveCtx: OfferingSaveContext = (initialEvent ??
    {}) as OfferingSaveContext;
  const isEvent = type === "webinar" || type === "class";
  // The saved event's own sessions read free in its time picker.
  const instanceId = saveCtx.instanceId;
  const ownEvent = React.useMemo<AvailabilityEvent | undefined>(() => {
    if (!instanceId) return undefined;
    if (type === "webinar") return { webinarId: instanceId, moving: true };
    if (type === "class") return { classId: instanceId, moving: true };
    return undefined;
  }, [instanceId, type]);

  // Wave-9 (#1230) — org-context pricing hint. A creator with an ACTIVE
  // canSponsor org membership is probably authoring an offering members will
  // book at ₹0 under a program; say so on the price field instead of letting
  // ₹0 look like an accident. Hint only fires while CREATING — editing keeps
  // the manifest's own description.
  const { data: session } = useSession();
  const sponsorPricingHint = resolveSponsorPricingHint(
    session?.user?.organizationMemberships,
  );
  const hintedManifest =
    !existingPlan && sponsorPricingHint
      ? applySponsorPricingHintToManifest(manifest, sponsorPricingHint)
      : manifest;
  const soldTermsNotice =
    type === "subscription"
      ? activeClientsNotice(activeClientsOf(initialEvent))
      : null;
  const noticedManifest = soldTermsNotice
    ? withPricingNotice(hintedManifest, soldTermsNotice)
    : hintedManifest;
  const effectiveManifest = onSave
    ? withoutTrial(noticedManifest)
    : noticedManifest;

  const form = useForm({
    resolver: zodResolver(adapter.schema),
    // Spread over the defaults rather than replacing them: a plan row saved
    // before a field existed must still populate that field, or the form
    // submits undefined and the API rejects it.
    defaultValues: {
      ...adapter.defaults,
      ...(copySource ? duplicateFormValues(copySource) : existingPlan),
    },
    mode: "onBlur",
  });

  const planId = (existingPlan?.id as string | undefined) ?? undefined;
  const [persistedStatus, setPersistedStatus] = React.useState<
    "DRAFT" | "PUBLISHED" | null
  >(null);
  const copySourceId = (copySource?.id as string | undefined) ?? undefined;
  const hydratedRef = React.useRef<string | undefined>(
    planId ?? (copySourceId ? `copy:${copySourceId}` : undefined),
  );
  React.useEffect(() => {
    const nextKey =
      planId ?? (copySourceId ? `copy:${copySourceId}` : undefined);
    if (hydratedRef.current !== nextKey) {
      hydratedRef.current = nextKey;
      setStagedImage(null);
      setPersistedStatus(null);
      let sourceValues: Record<string, unknown> | undefined;
      if (nextKey) {
        sourceValues = copySource
          ? duplicateFormValues(copySource)
          : existingPlan;
      }
      form.reset({
        ...adapter.defaults,
        ...sourceValues,
      });
    }
  }, [adapter.defaults, copySource, copySourceId, existingPlan, form, planId]);
  const status = persistedStatus ?? editorStatus(existingPlan, planId, saveCtx);
  // The org catalog's writer keeps its own reading of webinar/class status.
  const hasRealDraft = !isEvent || !onSave;
  // Publishing a webinar/class is one-way (EVENT_PUBLISHABLE_FROM).
  const canSaveDraft = !(isEvent && !onSave && status === "PUBLISHED");

  // #1527 §7.2 — unpublishing a plan people booked asks first. Existing
  // bookings stay; only new sales stop.
  const unpublishCanStrand =
    !onSave && !isEvent && status === "PUBLISHED" && !!planId;
  const tracksWaiting = isEvent && !onSave && !!planId;
  const stats = useQuery({
    queryKey: offeringStatsQueryKey(consultantId),
    queryFn: fetchOfferingStats,
    enabled: unpublishCanStrand || tracksWaiting,
    staleTime: 60_000,
  });
  const statRow = planId
    ? stats.data?.rows.find(
        (r) => `${r.planType}:${r.planId}` === offeringStatKey(type, planId),
      )
    : undefined;
  const bookings = statRow?.bookings ?? 0;
  // Unknown (null) while the stats read is pending or failed, never 0.
  let planWaiting: number | null = 0;
  if (tracksWaiting) {
    planWaiting = stats.data ? (statRow?.waitingCount ?? 0) : null;
  }
  const instanceWaiting =
    (saveCtx.instanceId && stats.data?.waitingByEvent[saveCtx.instanceId]) || 0;
  // #1527 review — an unresolved or failed stats read must not read as "0
  // bookings": that let an unpublish through with no confirmation while the
  // real count was simply unknown.
  const bookingsUnknown = unpublishCanStrand && !stats.data;
  const [publishRefusal, setPublishRefusal] = React.useState<string[] | null>(
    null,
  );
  const [pendingUnpublish, setPendingUnpublish] = React.useState<Record<
    string,
    unknown
  > | null>(null);

  /**
   * Why publishing is blocked, if it is. Returning the reason rather than a
   * boolean is deliberate — a disabled button with no explanation is the thing
   * people file bugs about.
   */
  // Deliberately NOT memoised. watch() subscribes the component so it
  // re-renders on every keystroke, but a memo keyed on [type, form] never
  // recomputes — both are stable for the editor's lifetime. The reason froze
  // at its first-render value, so Publish stayed blocked forever after the
  // user supplied the very field it was asking for (#1060).
  const watchedScheduledAt = form.watch("scheduledAt" as never);
  const watchedStartDate = form.watch("schedulingStartDate" as never);

  // The field list and the reason come out of the same branch: the draft path
  // skips exactly the fields publishing is waiting on, and nothing else.
  let publishOnlyFields: readonly string[] = [];
  let publishBlockedReason: string | null = null;
  if (type === "webinar") {
    publishOnlyFields = ["scheduledAt"];
    if (!watchedScheduledAt) {
      publishBlockedReason = "Add a session time before publishing.";
    }
  } else if (type === "class") {
    publishOnlyFields = ["schedulingStartDate"];
    if (!watchedStartDate) {
      publishBlockedReason = "Add the first session before publishing.";
    }
  }

  /** Cover-image changes are staged in the editor so Cancel never persists one. */
  const commitStagedImage = async (): Promise<boolean> => {
    if (!stagedImage || !planId) return true;
    try {
      await commitPlanImage(adapter.imageType, planId, stagedImage);
      setStagedImage(null);
      return true;
    } catch (imageError) {
      // The offering saved; keep the staged image and stay so a re-save retries it.
      toast({
        title: "Saved, but the cover image wasn't updated",
        description: `${imageError instanceof Error ? imageError.message : "Please try again."} Save again to retry.`,
        variant: "destructive",
      });
      return false;
    }
  };

  const persist = async (
    values: Record<string, unknown>,
    { publish }: { publish: boolean },
  ) => {
    setSavingAction(publish ? "publish" : "draft");
    setPublishRefusal(null);
    const wasPublishedBeforeSave = status === "PUBLISHED";
    try {
      const payload = {
        ...values,
        // A draft is authored but not live: it stays off the marketplace and
        // out of the detail pages for everyone but its owner.
        status: publish ? "SCHEDULED" : "DRAFT",
      };

      let saved: unknown;
      if (onSave) {
        await onSave(payload, { publish });
      } else {
        saved = await adapter.save(payload, consultantId, {
          ...saveCtx,
          capacityEdited:
            existingPlan?.maxParticipants === undefined ||
            Number(values.maxParticipants) !==
              Number(existingPlan.maxParticipants),
          startEdited: classStartEdited(values, existingPlan),
        });
      }
      setPersistedStatus(publish ? "PUBLISHED" : "DRAFT");
      // Re-read before the image commit so a failed image still shows the saved status.
      void invalidateOfferingQueries(queryClient, consultantId);
      if (!(await commitStagedImage())) return;

      const savedNotice = savedToast({
        publish,
        hasRealDraft,
        wasPublished: wasPublishedBeforeSave,
      });
      const hoursWarnings = feasibilityWarningsOf(saved);
      toast({
        ...savedNotice,
        description:
          [savedNotice.description, ...hoursWarnings]
            .filter(Boolean)
            .join(" ") || undefined,
      });

      router.push(returnHref ?? sellHomeHref(consultantId, type));
      router.refresh();
    } catch (error) {
      // A 4xx is the server's answer, not a fault.
      if (!isExpectedRefusal(error)) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "offerings" } },
        );
      }
      setPublishRefusal(feasibilityRefusalOf(error));
      toast({
        title:
          publish && !wasPublishedBeforeSave
            ? "Couldn't publish"
            : "Couldn't save",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingAction(null);
    }
  };

  return (
    <WaitingCountProvider
      value={{ plan: planWaiting, instance: instanceWaiting }}
    >
      <SessionHostProvider consultantProfileId={consultantId} event={ownEvent}>
        {publishRefusal && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>
              This plan can&apos;t be delivered from your published hours
            </AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-5">
                {publishRefusal.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p className="mt-2">
                Add hours in Availability, shorten the sessions, or lower the
                sessions a week, then save again.
              </p>
            </AlertDescription>
          </Alert>
        )}
        <OfferingEditor
          manifest={effectiveManifest}
          form={form}
          planId={planId}
          coverImage={
            planId
              ? {
                  staged: stagedImage,
                  // Ignored mid-save so a staged image can't pair with a stale save.
                  onStage: (image) => {
                    if (savingAction === null) setStagedImage(image);
                  },
                }
              : undefined
          }
          status={status}
          draftLabel={
            hasRealDraft && status === "PUBLISHED"
              ? "Unpublish (save as draft)"
              : undefined
          }
          canSaveDraft={canSaveDraft}
          previewHref={
            planId && !onSave ? publicOfferingHref(type, planId) : undefined
          }
          savingAction={savingAction}
          publishBlockedReason={publishBlockedReason}
          publishOnlyFields={publishOnlyFields}
          slots={{
            // Shared by all four, so it is wired here rather than four times.
            faq: <FaqEditor control={form.control} name="faqs" />,
            // ClassPlanSchema requires at least one curriculum item, so a class
            // literally cannot be saved without this.
            curriculum: (
              <ContentItemsEditor
                control={form.control}
                name="classContents"
                itemNoun="sessions"
              />
            ),
            roadmap: (
              <ContentItemsEditor
                control={form.control}
                name="subscriptionContents"
                itemNoun="sessions"
              />
            ),
            // Group events only. Collaborators attach to a plan id, so an
            // unsaved plan has nothing to invite onto yet.
            ...(type === "webinar" || type === "class"
              ? {
                  collaborators: planId ? (
                    <CollaboratorsTab
                      planType={type}
                      planId={planId}
                      planTitle={
                        typeof existingPlan?.title === "string"
                          ? existingPlan.title
                          : "this plan"
                      }
                      // The form holds rupees; the split works in paise.
                      planPricePaise={
                        typeof existingPlan?.price === "number"
                          ? Math.round(existingPlan.price * 100)
                          : 0
                      }
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Save this plan first, then invite collaborators here.
                    </p>
                  ),
                }
              : {}),
            // Files attach to a plan id, so there is nothing to list while
            // creating.
            materials: planId ? (
              <OfferingMaterials type={type} planId={planId} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Files attached to this offering appear here once it is saved.
              </p>
            ),
            ...extraSlots,
          }}
          onSaveDraft={(values) => {
            if (unpublishCanStrand && (bookings > 0 || bookingsUnknown)) {
              setPendingUnpublish(values as Record<string, unknown>);
              return;
            }
            return persist(values as Record<string, unknown>, {
              publish: false,
            });
          }}
          onPublish={(values) =>
            persist(values as Record<string, unknown>, { publish: true })
          }
          onCancel={() => router.back()}
        />
        <ConfirmDialog
          open={pendingUnpublish !== null}
          onOpenChange={(open) => {
            if (!open) setPendingUnpublish(null);
          }}
          title="Unpublish this offering?"
          description={
            bookingsUnknown
              ? "We couldn't confirm whether anyone has booked it. Existing bookings are unaffected either way; it just stops taking new ones until you publish it again."
              : `${bookings} ${bookings === 1 ? "person has" : "people have"} booked it. Existing bookings are unaffected; it just stops taking new ones until you publish it again.`
          }
          confirmLabel="Unpublish"
          onConfirm={async () => {
            if (pendingUnpublish) {
              await persist(pendingUnpublish, { publish: false });
            }
            setPendingUnpublish(null);
          }}
        />
      </SessionHostProvider>
    </WaitingCountProvider>
  );
}
