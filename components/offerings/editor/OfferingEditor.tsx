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
import type { FieldErrors, FieldValues, UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
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
    manifest.sections[0]?.id ?? "",
  );

  const isSaving = savingAction !== null;

  // Open the first tab (manifest order) that owns an errored field, so a
  // hidden panel can never swallow a validation error. react-hook-form
  // re-focuses the field after onInvalid, by which time the tab is shown.
  const revealFirstError = (names: string[]) => {
    const errored = new Set(names);
    const section = manifest.sections.find((s) =>
      [
        ...s.fields.flatMap((f) =>
          f.currencyName ? [f.name, f.currencyName] : [f.name],
        ),
        ...(s.slotFields ?? []),
      ].some((n) => errored.has(n)),
    );
    if (section) setActiveSection(section.id);
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
      else revealFirstError(blocking);
    },
  );
  const submitPublish = form.handleSubmit(
    (values) => onPublish(values),
    (errors: FieldErrors<T>) => revealFirstError(Object.keys(errors)),
  );

  return (
    <Form {...form}>
      {/*
        No bottom padding: the save bar below is mt-auto inside this flex
        column (see its comment), so trailing padding would only reopen dead
        run-out under it (DashboardContent's py-6 already leaves the small
        breathing gap).
      */}
      <form
        className="flex flex-1 flex-col"
        onSubmit={(e) => {
          // Both actions are explicit footer buttons; a stray Enter must not
          // publish an offering.
          e.preventDefault();
        }}
      >
        {/*
          Real tabs, one section visible at a time. The strip used to be jump
          links over one long form with a scroll-spy highlight, which could not
          top-align the trailing sections (the scroller ran out of room) and lit
          "Extras" while Content's tail sat under the header. `contents` keeps
          the band and the panels direct flex children of the form, so the
          save bar's mt-auto below still pins to the bottom on a short panel.
          The band is the page's only title: the sticky one survives scrolling
          and carries the Draft/Published badge.
        */}
        <Tabs
          value={activeSection}
          onValueChange={setActiveSection}
          className="contents"
        >
          <div className="sticky top-0 z-20 mb-6 border-b bg-background pb-3 pt-1">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold">
                {planId ? "Edit" : "New"} {manifest.noun}
              </h1>
              {status === "DRAFT" && <Badge variant="outline">Draft</Badge>}
              {status === "PUBLISHED" && <Badge>Published</Badge>}
            </div>

            <TabsList
              aria-label="Offering sections"
              className="h-auto flex-wrap gap-2 rounded-none bg-transparent p-0"
            >
              {manifest.sections.map((section) => (
                <TabsTrigger
                  key={section.id}
                  value={section.id}
                  className="px-3 py-1.5 font-normal text-muted-foreground hover:bg-secondary/50 data-[state=active]:bg-secondary data-[state=active]:font-medium data-[state=active]:text-secondary-foreground data-[state=active]:shadow-none"
                >
                  {section.title}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* pb-8 keeps the standing gap above the save bar: the bar's mt-auto
              collapses to 0 once the panel is taller than <main>, so the spacer
              lives here rather than on the bar. forceMount keeps every field
              registered with react-hook-form across tab switches — values and
              validation must not reset when a panel is hidden. */}
          <div className="pb-8">
            {manifest.sections.map((section) => (
              <TabsContent
                key={section.id}
                value={section.id}
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
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
              </TabsContent>
            ))}
          </div>
        </Tabs>

        {/*
          Sticky to <main> (the dashboard scrollport) rather than the viewport:
          a fixed bar drew itself under the sidebar (needing md:left-64) and
          forced a giant compensating pb-24 on the form, which is what let the
          page scroll into dead space past its content. As the form's last
          child it naturally clears the sidebar and every shell chrome.
          mt-auto is the other half: the form is a flex column stretched to
          <main>'s full height, so on a short form (tall monitor, edit page)
          the bar pins to the bottom edge instead of floating mid-air right
          after the last section; on a long form mt-auto collapses to 0 and
          plain sticky takes over.
          REQUIRES the page's <DashboardContent> to carry `content-flush-bottom`
          (see globals.css): without it, the stacked chrome paddings below this
          bar leave a ~40-56px float above the true bottom edge.
        */}
        <div className="sticky bottom-0 z-10 mt-auto border-t bg-background/95 backdrop-blur">
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
              onClick={submitPublish}
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
