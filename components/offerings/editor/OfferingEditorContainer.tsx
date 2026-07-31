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
import { OFFERING_ADAPTERS } from "./adapters";
import { OFFERING_MANIFESTS } from "./manifests";
import type { OfferingType } from "./manifest";

interface OfferingEditorContainerProps {
  type: OfferingType;
  consultantId: string;
  /** The planner event being edited, or undefined when creating. */
  initialEvent?: unknown;
  /** Extra bespoke sections, keyed by the manifest's `slot`. */
  extraSlots?: Record<string, React.ReactNode>;
  /** Where to go once saved. Defaults to the planner. */
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

export function OfferingEditorContainer({
  type,
  consultantId,
  initialEvent,
  extraSlots,
  returnHref,
  onSave,
}: Readonly<OfferingEditorContainerProps>) {
  const router = useRouter();
  const adapter = OFFERING_ADAPTERS[type];
  const manifest = OFFERING_MANIFESTS[type];
  const [isSaving, setIsSaving] = React.useState(false);

  const existingPlan = initialEvent ? adapter.planOf(initialEvent) : undefined;

  const form = useForm({
    resolver: zodResolver(adapter.schema),
    // Spread over the defaults rather than replacing them: a plan row saved
    // before a field existed must still populate that field, or the form
    // submits undefined and the API rejects it.
    defaultValues: { ...adapter.defaults, ...(existingPlan ?? {}) },
    mode: "onBlur",
  });

  const planId = (existingPlan?.id as string | undefined) ?? undefined;

  /**
   * Why publishing is blocked, if it is. Returning the reason rather than a
   * boolean is deliberate — a disabled button with no explanation is the thing
   * people file bugs about.
   */
  const publishBlockedReason = React.useMemo(() => {
    if (type === "webinar" && !form.watch("scheduledAt" as never)) {
      return "Add a session time before publishing.";
    }
    if (type === "class" && !form.watch("schedulingStartDate" as never)) {
      return "Add a start date before publishing.";
    }
    return null;
    // watch() already subscribes this component to the fields it reads.
  }, [type, form]);

  const persist = async (
    values: Record<string, unknown>,
    { publish }: { publish: boolean },
  ) => {
    setIsSaving(true);
    try {
      const payload = {
        ...values,
        // A draft is authored but not live: it stays off the marketplace and
        // out of the detail pages for everyone but its owner.
        status: publish ? "SCHEDULED" : "DRAFT",
      };

      if (onSave) {
        await onSave(payload, { publish });
      } else {
        await adapter.save(payload, consultantId);
      }

      toast({
        title: publish ? "Offering published" : "Draft saved",
        description: publish
          ? "It's now visible to buyers."
          : "Only you can see this until you publish it.",
      });

      router.push(returnHref ?? `/dashboard/consultant/${consultantId}/planner`);
      router.refresh();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "offerings" } },
      );
      toast({
        title: publish ? "Couldn't publish" : "Couldn't save",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <OfferingEditor
      manifest={manifest}
      form={form}
      planId={planId}
      planImageType={adapter.imageType}
      status={planId ? "PUBLISHED" : null}
      isSaving={isSaving}
      publishBlockedReason={publishBlockedReason}
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
        // Group events only, and only once saved — collaborators attach to a
        // plan id, so there is nothing to attach to while creating.
        ...((type === "webinar" || type === "class") && planId
          ? {
              collaborators: (
                <CollaboratorsTab
                  planType={type}
                  planId={planId}
                  isOwner
                />
              ),
            }
          : {}),
        ...extraSlots,
      }}
      onSaveDraft={(values) =>
        persist(values as Record<string, unknown>, { publish: false })
      }
      onPublish={(values) =>
        persist(values as Record<string, unknown>, { publish: true })
      }
      onCancel={() => router.back()}
    />
  );
}
