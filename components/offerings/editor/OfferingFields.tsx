"use client";

/**
 * The single field renderer.
 *
 * One grid definition serves all four offering types. The four dialogs this
 * replaces each declared their own — `md:grid-cols-2` three times and
 * `md:grid-cols-3` once — which is why the same section looked different
 * depending on which offering you were editing.
 */

import {
  get,
  useWatch,
  type Control,
  type ControllerRenderProps,
  type FieldValues,
} from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  RequiredMark,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { PriceField } from "@/components/planner/components/form-fields/PriceField";
import { LanguageLevelFields } from "@/components/planner/components/form-fields/LanguageLevelFields";
import { LearningOutcomesField } from "@/components/planner/components/form-fields/LearningOutcomesField";
import { StringListField } from "@/components/planner/components/form-fields/StringListField";
import { PlanLengthField } from "@/components/planner/components/form-fields/PlanLengthField";
import {
  PlanImageUploader,
  type StagedPlanImage,
} from "@/components/plans/PlanImageUploader";
import type { FieldSpec } from "./manifest";
import { useWaitingCounts } from "./waiting-count";
import { WaitlistSwitch } from "./WaitlistSwitch";
import { SessionTimeField } from "./session-time-field";

/** Sections are a 6-column grid so halves and thirds both land cleanly. */
const SPAN_CLASS: Record<NonNullable<FieldSpec["span"]>, string> = {
  2: "md:col-span-2",
  3: "md:col-span-3",
  6: "md:col-span-6",
};

/**
 * The control for one field kind.
 *
 * Lives outside the component because it was a ninety-line switch inlined in
 * JSX, which both the analyser and a reader mistake for a nested component.
 */
function renderControl<T extends FieldValues = FieldValues>(
  spec: FieldSpec,
  field: ControllerRenderProps<T, never>,
  coverImage: CoverImageControl | undefined,
) {
  switch (spec.kind) {
    case "textarea":
      return (
        <Textarea
          placeholder={spec.placeholder}
          // Long-form reads best under ~75 characters a line; uncapped it
          // spans the full 1008px grid and the eye loses the line.
          className="min-h-24 max-w-2xl"
          {...field}
          value={field.value ?? ""}
        />
      );
    case "number":
      return (
        <Input
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          placeholder={spec.placeholder}
          {...field}
          value={field.value ?? ""}
          onChange={(e) =>
            field.onChange(
              e.target.value === ""
                ? undefined
                : Number.parseFloat(e.target.value),
            )
          }
        />
      );
    case "select":
      // FormControl sits on the trigger: Select's root renders no element to label.
      return (
        <Select onValueChange={field.onChange} value={field.value ?? undefined}>
          <FormControl>
            <SelectTrigger>
              <SelectValue placeholder={spec.placeholder} />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            {spec.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "switch":
      return (
        <Switch checked={!!field.value} onCheckedChange={field.onChange} />
      );
    case "minutesChoice":
      return <MinutesChoice spec={spec} field={field} />;
    case "image":
      return coverImage ? (
        <PlanImageUploader
          currentImageUrl={field.value ?? null}
          staged={coverImage.staged}
          onStage={coverImage.onStage}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Save this offering as a draft first, then add a cover image.
        </p>
      );
    default:
      return (
        <Input
          placeholder={spec.placeholder}
          className="max-w-2xl"
          {...field}
          value={field.value ?? ""}
        />
      );
  }
}

/** A few fixed lengths as radio buttons; a stored length outside them is named until it is changed. */
function MinutesChoice<T extends FieldValues = FieldValues>({
  spec,
  field,
}: Readonly<{ spec: FieldSpec; field: ControllerRenderProps<T, never> }>) {
  const choices = spec.minuteChoices ?? [];
  const current = typeof field.value === "number" ? field.value : null;
  return (
    <div className="space-y-2">
      <RadioGroup
        className="flex h-9 items-center gap-4"
        value={current === null ? "" : String(current)}
        onValueChange={(value) => field.onChange(Number(value))}
      >
        {choices.map((minutes) => (
          <div key={minutes} className="flex items-center gap-2">
            <RadioGroupItem
              value={String(minutes)}
              id={`${spec.name}-${minutes}`}
            />
            <Label htmlFor={`${spec.name}-${minutes}`}>{minutes} minutes</Label>
          </div>
        ))}
      </RadioGroup>
      {current !== null && !choices.includes(current) && (
        <p className="text-xs text-muted-foreground">
          Saved as {current} minutes. Choose one of these to save changes.
        </p>
      )}
    </div>
  );
}

/** The cover-image change staged until save; absent while creating (no plan id to attach to). */
export interface CoverImageControl {
  staged: StagedPlanImage | null;
  onStage: (change: StagedPlanImage | null) => void;
}

interface OfferingFieldProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  spec: FieldSpec;
  coverImage?: CoverImageControl;
}

export function OfferingField<T extends FieldValues = FieldValues>({
  control,
  spec,
  coverImage,
}: Readonly<OfferingFieldProps<T>>) {
  const span = SPAN_CLASS[spec.span ?? 6];
  const waiting = useWaitingCounts().instance;
  const { shownWhen } = spec;
  const shown = useWatch({
    control,
    compute: (values: T) => !shownWhen || Boolean(get(values, shownWhen)),
  });
  if (!shown) return null;

  // Composite fields own their own internal layout; they just need the cell.
  if (spec.kind === "languageLevel") {
    return (
      <div className={span}>
        <LanguageLevelFields control={control} gridCols={2} />
      </div>
    );
  }

  if (spec.kind === "price") {
    return (
      <div className={span}>
        <PriceField
          control={control}
          priceName={spec.name}
          currencyName={spec.currencyName ?? "priceCurrency"}
          label={spec.label}
          description={spec.description}
          required={spec.required}
        />
      </div>
    );
  }

  if (spec.kind === "sessionTime") {
    return (
      <div className={span}>
        <SessionTimeField control={control} spec={spec} />
      </div>
    );
  }

  if (spec.kind === "planLength") {
    return (
      <div className={span}>
        <PlanLengthField control={control} required={spec.required} />
      </div>
    );
  }

  if (spec.kind === "learningOutcomes") {
    return (
      <div className={span}>
        <LearningOutcomesField
          control={control}
          name={spec.name}
          label={spec.label}
          description={spec.description}
          maxItems={spec.maxItems}
          required={spec.required}
        />
      </div>
    );
  }

  if (spec.kind === "stringList") {
    return (
      <div className={span}>
        <StringListField
          control={control}
          name={spec.name}
          label={spec.label}
          description={spec.description}
          itemNoun={spec.itemNoun}
          maxItems={spec.maxItems}
          required={spec.required}
        />
      </div>
    );
  }

  return (
    <FormField
      control={control}
      name={spec.name as never}
      render={({ field }) => (
        <FormItem className={span}>
          {spec.label && (
            <FormLabel>
              {spec.label}
              {spec.required && <RequiredMark />}
            </FormLabel>
          )}
          {spec.kind === "select" && renderControl(spec, field, coverImage)}
          {spec.name === "waitlistEnabled" && (
            <div className="flex h-9 items-center">
              <WaitlistSwitch
                checked={!!field.value}
                onCheckedChange={field.onChange}
              />
            </div>
          )}
          {spec.kind === "switch" && spec.name !== "waitlistEnabled" && (
            // A switch is inline, so it sat on the label's line; the h-9 row
            // stacks it under the label at the same height as its neighbours.
            <div className="flex h-9 items-center">
              <FormControl>
                {renderControl(spec, field, coverImage)}
              </FormControl>
            </div>
          )}
          {spec.kind !== "select" && spec.kind !== "switch" && (
            <FormControl>{renderControl(spec, field, coverImage)}</FormControl>
          )}
          {spec.description && (
            <FormDescription>{spec.description}</FormDescription>
          )}
          {spec.name === "maxParticipants" && waiting > 0 && (
            <FormDescription className="font-medium text-foreground">
              {waiting} waiting — raising capacity notifies them.
            </FormDescription>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
