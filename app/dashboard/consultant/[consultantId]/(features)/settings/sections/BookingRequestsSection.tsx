"use client";

import { BookingMode } from "@prisma/client";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { RadioGroup, RadioGroupItem } from "components/ui/radio-group";
import { Separator } from "components/ui/separator";
import { Switch } from "components/ui/switch";
import type { Dispatch, SetStateAction } from "react";
import type { FormData } from "../settings";

interface BookingRequestsSectionProps {
  formData: FormData;
  setFormData: Dispatch<SetStateAction<FormData>>;
}

/** The cap's accepted range; blank means no limit (#1703 D4). */
export const MAX_OPEN_REQUESTS_RANGE = { min: 1, max: 50 } as const;

/** Blank clears the cap; anything else is clamped into the range. */
export function parseMaxOpenRequests(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  return Math.min(
    MAX_OPEN_REQUESTS_RANGE.max,
    Math.max(MAX_OPEN_REQUESTS_RANGE.min, n),
  );
}

/**
 * "Booking requests" tab of the consultant settings form (#1703 D1/D4).
 * Presentational: the three fields ride the combined settings PUT.
 */
export function BookingRequestsSection({
  formData,
  setFormData,
}: Readonly<BookingRequestsSectionProps>) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Booking requests</h3>
        <p className="text-sm text-muted-foreground">
          How new bookings reach your calendar, and whether you are taking new
          requests right now.
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
          <Label htmlFor="accepting-requests">Accepting new requests</Label>
          <p className="text-sm text-muted-foreground">
            Turn this off to pause new requests. Requests already open are not
            affected, and your profile stays visible.
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
              maxOpenRequests: parseMaxOpenRequests(e.target.value),
            }))
          }
        />
        <p className="text-sm text-muted-foreground">
          Once this many requests are waiting on you, new ones are refused until
          you answer some. Leave blank for no limit.
        </p>
      </div>
    </div>
  );
}
