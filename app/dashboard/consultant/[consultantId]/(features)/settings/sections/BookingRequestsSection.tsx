"use client";

import { BookingMode } from "@prisma/client";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { RadioGroup, RadioGroupItem } from "components/ui/radio-group";
import { Separator } from "components/ui/separator";
import { Switch } from "components/ui/switch";
import type { Dispatch, SetStateAction } from "react";
import { MAX_ACTIVE_PLAN_CLIENTS_RANGE } from "@/schemas/plan-clients";
import type { BookingRequestSettings } from "../settings";

interface BookingRequestsSectionProps {
  value: BookingRequestSettings;
  onChange: Dispatch<SetStateAction<BookingRequestSettings>>;
  /** Distinct buyers holding one of your plans now; null while it loads. */
  activePlanClients: number | null;
  /** The plan-client limit exactly as typed, and why it is refused (null when valid). */
  limitDraft: string;
  limitError: string | null;
  /** The limit the count line names: a valid typed value, else the saved one. */
  countLimit: number | null;
  onLimitDraftChange: (raw: string) => void;
}

/** The cap's accepted range; blank means no limit (#1703 D4). */
export const MAX_OPEN_REQUESTS_RANGE = { min: 1, max: 50 } as const;

/**
 * Blank clears the cap; a number is truncated and clamped into the range;
 * anything unparseable keeps the current cap (only blank may clear it).
 */
export function parseMaxOpenRequests(
  raw: string,
  current: number | null,
): number | null {
  if (raw.trim() === "") return null;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return current;
  return Math.min(
    MAX_OPEN_REQUESTS_RANGE.max,
    Math.max(MAX_OPEN_REQUESTS_RANGE.min, n),
  );
}

/** "3 of 5 active plan clients", or "3 active plan clients" with no limit. */
export function planClientsLine(active: number, limit: number | null): string {
  const noun = (n: number) =>
    n === 1 ? "active plan client" : "active plan clients";
  return limit === null
    ? `${active} ${noun(active)}`
    : `${active} of ${limit} ${noun(limit)}`;
}

/**
 * "Booking mode" settings. Presentational: the form saves the changed
 * fields through the booking-settings PATCH.
 */
export function BookingRequestsSection({
  value: formData,
  onChange: setFormData,
  activePlanClients,
  limitDraft,
  limitError,
  countLimit,
  onLimitDraftChange,
}: Readonly<BookingRequestsSectionProps>) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Booking mode</h3>
        <p className="text-sm text-muted-foreground">
          How new bookings reach your calendar, and whether you are taking new
          1:1 bookings right now.
        </p>
      </div>

      <div className="space-y-3">
        <Label>How people book you</Label>
        <RadioGroup
          value={formData.bookingMode}
          onValueChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              bookingMode:
                value === BookingMode.REQUEST
                  ? BookingMode.REQUEST
                  : BookingMode.INSTANT,
            }))
          }
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem
              value={BookingMode.INSTANT}
              id="booking-mode-instant"
              className="mt-1"
            />
            <Label htmlFor="booking-mode-instant" className="font-normal">
              <span className="font-medium">Instant booking</span>
              <span className="block text-sm text-muted-foreground">
                A free slot is paid and confirmed on the spot. Only a time
                someone else is already holding comes to you as a request.
              </span>
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem
              value={BookingMode.REQUEST}
              id="booking-mode-request"
              className="mt-1"
            />
            <Label htmlFor="booking-mode-request" className="font-normal">
              <span className="font-medium">Review requests first</span>
              <span className="block text-sm text-muted-foreground">
                Every time comes to you as a request. Nobody pays until you
                approve, and the pay link stays open for 24 hours.
              </span>
            </Label>
          </div>
        </RadioGroup>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="accepting-requests">
            Taking new 1:1 bookings and trials
          </Label>
          <p className="text-sm text-muted-foreground">
            Turn this off to pause new 1:1 bookings and trials (webinars and
            classes keep selling). Requests already open are not affected, and
            your profile stays visible.
          </p>
        </div>
        <Switch
          id="accepting-requests"
          checked={formData.acceptingRequests}
          onCheckedChange={(checked) =>
            setFormData((prev) => ({ ...prev, acceptingRequests: checked }))
          }
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="max-open-requests">Limit open requests to</Label>
        <Input
          id="max-open-requests"
          type="number"
          inputMode="numeric"
          min={MAX_OPEN_REQUESTS_RANGE.min}
          max={MAX_OPEN_REQUESTS_RANGE.max}
          placeholder="No limit"
          className="max-w-[10rem]"
          value={formData.maxOpenRequests ?? ""}
          onChange={(e) =>
            setFormData((prev) => ({
              ...prev,
              maxOpenRequests: parseMaxOpenRequests(
                e.target.value,
                prev.maxOpenRequests,
              ),
            }))
          }
        />
        <p className="text-sm text-muted-foreground">
          Once this many requests are waiting on you, new ones are refused until
          you answer some. Leave blank for no limit.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="max-active-plan-clients">
          Limit mentorship plan clients to
        </Label>
        <Input
          id="max-active-plan-clients"
          type="number"
          inputMode="numeric"
          min={MAX_ACTIVE_PLAN_CLIENTS_RANGE.min}
          max={MAX_ACTIVE_PLAN_CLIENTS_RANGE.max}
          step={1}
          placeholder="No limit"
          className="max-w-[10rem]"
          value={limitDraft}
          aria-invalid={limitError !== null}
          aria-describedby={
            limitError ? "max-active-plan-clients-error" : undefined
          }
          onChange={(e) => onLimitDraftChange(e.target.value)}
        />
        {limitError && (
          <p
            id="max-active-plan-clients-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {limitError}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Once this many people hold one of your plans, your plans show as fully
          booked and new buyers are refused before they pay. Current clients
          keep their plans. Leave blank for no limit.
        </p>
        {activePlanClients !== null && (
          <p className="text-sm font-medium" aria-live="polite">
            {planClientsLine(activePlanClients, countLimit)}
          </p>
        )}
      </div>
    </div>
  );
}
