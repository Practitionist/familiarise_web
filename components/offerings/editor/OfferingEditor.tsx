"use client";

/**
 * The offering editor shell.
 *
 * Replaces four hand-built modals (3,890 lines) whose height had already
 * outgrown a dialog — every one of them carried
 * `max-h-[90dvh] overflow-hidden flex flex-col`, which is a page admitting it
 * is a page. A route-based editor also gives an offering a stable URL to return
 * to, which is what makes saving a draft mean anything.
 *
 * Layout is not decided here per type: the manifest lists sections, this walks
 * them, and `OfferingField` renders every field into one shared 6-column grid.
 */

import * as React from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";
import type { TPlanImageType } from "@/lib/supabase";
import { FormSection } from "@/components/planner/components/form-fields/FormSection";
import { OfferingField } from "./OfferingFields";
import type { OfferingManifest } from "./manifest";

export interface OfferingEditorProps<T extends FieldValues = FieldValues> {
  manifest: OfferingManifest;
  form: UseFormReturn<T>;
  /**
   * Sections the manifest marks with a `slot` — the FAQ editor, the curriculum
   * builder, the sessions calendar. Anything genuinely bespoke lives here
   * rather than being forced into a field kind.
   */
  slots?: Record<string, React.ReactNode>;
  /** Absent while creating: there is no offering to attach an image to yet. */
  planId?: string;
  planImageType?: TPlanImageType;
  /** Null while creating. DRAFT offerings are not buyable and not discoverable. */
  status?: "DRAFT" | "PUBLISHED" | null;
  /**
   * Which action is in flight. Per-action rather than one `isSaving`, so the
   * button the user pressed is the only one that reacts — a spinner on Publish
   * after pressing Save draft is a lie about what is happening.
   */
  savingAction?: "draft" | "publish" | null;
  /**
   * Why publishing is blocked, if it is — e.g. a webinar with no session. The
   * reason is shown next to the disabled button, because a disabled control
   * with no explanation is the thing people file bugs about.
   */
  publishBlockedReason?: string | null;
  /**
   * Fields only publishing requires. The draft path ignores validation errors
   * confined to these: an offering that cannot be saved until it is publishable
   * is not a draft.
   */
  publishOnlyFields?: readonly string[];
  onSaveDraft: (values: T) => void | Promise<void>;
  onPublish: (values: T) => void | Promise<void>;
  onCancel?: () => void;
}

export function OfferingEditor<T extends FieldValues = FieldValues>({
  manifest,
  form,
  slots,
  planId,
  planImageType,
  status = null,
  savingAction = null,
  publishBlockedReason = null,
  publishOnlyFields,
  onSaveDraft,
  onPublish,
  onCancel,
}: Readonly<OfferingEditorProps<T>>) {
  const [activeSection, setActiveSection] = React.useState(
    manifest.sections[0]?.id,
  );

  const isSaving = savingAction !== null;

  const scrollTo = (id: string) => {
    setActiveSection(id);
    document
      .getElementById(`offering-section-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Publishing validates in full; a draft only has to clear the errors that are
  // not publish-only, so partial work can still be parked.
  const submitDraft = form.handleSubmit(
    (values) => onSaveDraft(values),
    (errors) => {
      const blocking = Object.keys(errors).filter(
        (name) => !publishOnlyFields?.includes(name),
      );
      if (blocking.length === 0) void onSaveDraft(form.getValues());
    },
  );

  return (
    <Form {...form}>
      <form
        className="pb-24"
        onSubmit={(e) => {
          // Both actions are explicit footer buttons; a stray Enter must not
          // publish an offering.
          e.preventDefault();
        }}
      >
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold capitalize">
            {planId ? "Edit" : "New"} {manifest.noun}
          </h1>
          {status === "DRAFT" && <Badge variant="outline">Draft</Badge>}
          {status === "PUBLISHED" && <Badge>Published</Badge>}
        </div>

        <nav className="mb-6 flex flex-wrap gap-2 border-b pb-3">
          {manifest.sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => scrollTo(section.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                activeSection === section.id
                  ? "bg-secondary font-medium text-secondary-foreground"
                  : "text-muted-foreground hover:bg-secondary/50",
              )}
            >
              {section.title}
            </button>
          ))}
        </nav>

        <div className="space-y-8">
          {manifest.sections.map((section) => (
            <div key={section.id} id={`offering-section-${section.id}`}>
              <FormSection
                title={section.title}
                description={section.description}
                icon={section.icon}
              >
                {section.slot ? (
                  (slots?.[section.slot] ?? (
                    <p className="text-sm text-muted-foreground">
                      Nothing to configure here yet.
                    </p>
                  ))
                ) : (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
                    {section.fields.map((spec) => (
                      <OfferingField
                        key={spec.name}
                        control={form.control}
                        spec={spec}
                        planId={planId}
                        planImageType={planImageType}
                      />
                    ))}
                  </div>
                )}
              </FormSection>
            </div>
          ))}
        </div>

        <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-end gap-3 px-4 py-3">
            {publishBlockedReason && (
              <p className="mr-auto text-sm text-muted-foreground">
                {publishBlockedReason}
              </p>
            )}
            {onCancel && (
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving}
              >
                Cancel
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={submitDraft}
            >
              {savingAction === "draft" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save draft
            </Button>
            <Button
              type="button"
              disabled={isSaving || !!publishBlockedReason}
              onClick={form.handleSubmit(onPublish)}
            >
              {savingAction === "publish" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {status === "PUBLISHED" ? "Save changes" : "Publish"}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}
