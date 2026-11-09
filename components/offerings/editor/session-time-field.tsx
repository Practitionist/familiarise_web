"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useWatch, type Control, type FieldValues } from "react-hook-form";

import { SingleSessionPicker } from "@/components/scheduling/SingleSessionPicker";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  RequiredMark,
} from "@/components/ui/form";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import type { FieldSpec } from "./manifest";

/** The host whose calendar labels an offering's session times; absent outside the editor. */
const SessionHostContext = createContext<{
  consultantProfileId: string;
} | null>(null);

export function SessionHostProvider({
  consultantProfileId,
  children,
}: Readonly<{ consultantProfileId: string; children: ReactNode }>) {
  return (
    <SessionHostContext.Provider value={{ consultantProfileId }}>
      {children}
    </SessionHostContext.Provider>
  );
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A webinar's start, picked on the host's own calendar in the host's zone
 * with the event-time rules (half hour, an hour ahead) the server enforces.
 * The form keeps a Date, as the previous date-time input did.
 */
export function SessionTimeField<T extends FieldValues = FieldValues>({
  control,
  spec,
}: Readonly<{ control: Control<T>; spec: FieldSpec }>) {
  const host = useContext(SessionHostContext);
  const { zone } = useViewerZone();
  const hours = useWatch({
    control,
    compute: (values: T) =>
      Number((values as Record<string, unknown>)[spec.durationName ?? ""]) || 1,
  });
  return (
    <FormField
      control={control}
      name={spec.name as never}
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {spec.label}
            {spec.required && <RequiredMark />}
          </FormLabel>
          <FormControl>
            {host ? (
              <SingleSessionPicker
                consultantId={host.consultantProfileId}
                zone={zone}
                sessionMinutes={Math.round(hours * 60)}
                purpose="create"
                value={toIso(field.value)}
                onChange={(iso) => field.onChange(iso ? new Date(iso) : null)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Save the offering first, then pick its time.
              </p>
            )}
          </FormControl>
          {spec.description && (
            <FormDescription>{spec.description}</FormDescription>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
