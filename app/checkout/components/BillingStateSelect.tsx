"use client";

/**
 * Billing-state picker for the GST place of supply (#1365).
 *
 * Deliberately optional and off the critical path: under s.12(2)(b) of the
 * IGST Act a B2C supply with no address of the recipient on record is supplied
 * at the SUPPLIER's own location, so leaving this blank produces a correct
 * intra-state tax invoice rather than an incomplete one. It exists so a buyer
 * in another state gets an IGST invoice their accountant will accept, not so
 * that checkout can demand an answer before taking money.
 *
 * Submits the 2-digit NUMERIC code, which is what the GST portal, the invoice
 * and `lib/compliance/gst.ts` all compare on. Once a buyer picks a state,
 * checkout remembers it on their consultee profile and this field arrives
 * pre-filled next time.
 */

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GST_STATE_OPTIONS } from "@/lib/compliance/state-codes";

export interface BillingStateSelectProps {
  /** The 2-digit numeric state code, or null when nothing has been chosen. */
  value: string | null;
  onChange: (stateCode: string | null) => void;
  disabled?: boolean;
}

/** Sentinel for the "no answer" option. Radix Select forbids an empty-string
 *  item value, and null is what the API wants for the statutory default. */
const NOT_SPECIFIED = "__unspecified__";

export function BillingStateSelect({
  value,
  onChange,
  disabled,
}: Readonly<BillingStateSelectProps>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="billing-state">Billing state (for GST)</Label>
      <Select
        value={value ?? NOT_SPECIFIED}
        onValueChange={(next) => onChange(next === NOT_SPECIFIED ? null : next)}
        disabled={disabled}
      >
        <SelectTrigger id="billing-state" className="w-full">
          <SelectValue placeholder="Optional" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_SPECIFIED}>Not specified</SelectItem>
          {GST_STATE_OPTIONS.map((option) => (
            <SelectItem key={option.code} value={option.code}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Optional. We use this only to decide the place of supply on your tax
        invoice. If you leave it blank, the invoice is issued at our own
        location, as the GST rules provide.
      </p>
    </div>
  );
}
