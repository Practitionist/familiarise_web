"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useWatch, type Control, type FieldValues } from "react-hook-form";

import {
  SINGLE_TIME_PICKER_MAX_WIDTH,
  SingleTimePicker,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  RequiredMark,
} from "@/components/ui/form";
import type { AvailabilityEvent } from "@/lib/scheduling/use-availability-window";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import type { FieldSpec } from "./manifest";

/**
 * The host whose calendar labels an offering's session times, and the saved
 * webinar or class being edited, whose own sessions read free; absent outside the editor.
 */
const SessionHostContext = createContext<{
  consultantProfileId: string;
  event?: AvailabilityEvent;
} | null>(null);

export function SessionHostProvider({
  consultantProfileId,
  event,
  children,
}: Readonly<{
  consultantProfileId: string;
  event?: AvailabilityEvent;
  children: ReactNode;
}>) {
  const value = useMemo(
    () => ({ consultantProfileId, event }),
    [consultantProfileId, event],
  );
  return (
    <SessionHostContext.Provider value={value}>
      {children}
    </SessionHostContext.Provider>
  );
}

function toValue(value: unknown, minutes: number): SingleTimeValue | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return null;
  return {
    startsAt: date.toISOString(),
    endsAt: new Date(date.getTime() + minutes * 60_000).toISOString(),
  };
}

/**
 * A webinar's start or a class's first session, picked on the host's own
 * calendar with the event-time rules the server enforces. The form keeps an
 * ISO string.
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
        <FormItem className={SINGLE_TIME_PICKER_MAX_WIDTH}>
          <FormLabel>
            {spec.label}
            {spec.required && <RequiredMark />}
          </FormLabel>
          <FormControl>
            {host ? (
              <SingleTimePicker
                consultantId={host.consultantProfileId}
                zone={zone}
                theme="light"
                audience="host"
                sessionMinutes={Math.round(hours * 60)}
                purpose="create"
                event={host.event}
                value={toValue(field.value, Math.round(hours * 60))}
                onChange={(picked) => field.onChange(picked?.startsAt ?? null)}
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
