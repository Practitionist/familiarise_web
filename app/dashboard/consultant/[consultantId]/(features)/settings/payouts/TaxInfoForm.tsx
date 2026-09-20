"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";

import {
  saveTaxInfo,
  type PayoutSetup,
  type TaxInfoInput,
} from "./get-paid-api";
import {
  usePayoutSetupInvalidation,
  useRefusalToast,
} from "./PayoutAccountForm";

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const ENTITY_OPTIONS: Array<
  [NonNullable<TaxInfoInput["taxEntityType"]>, string]
> = [
  ["INDIVIDUAL", "Individual"],
  ["HUF", "Hindu undivided family"],
  ["PARTNERSHIP", "Partnership firm"],
  ["LLP", "LLP"],
  ["COMPANY", "Company"],
];

const MSME_OPTIONS: Array<[NonNullable<TaxInfoInput["msmeStatus"]>, string]> = [
  ["NONE", "Not registered"],
  ["MICRO", "Micro"],
  ["SMALL", "Small"],
  ["MEDIUM", "Medium"],
];

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/**
 * PAN + entity type, with GSTIN and the MSME declaration as optional extras,
 * all on the existing PUT route. The PAN goes over the wire once and is
 * encrypted at rest; the page only ever shows its last four characters back.
 */
export function TaxInfoForm({
  consultantId,
  current,
  onSaved,
}: Readonly<{
  consultantId: string;
  current: PayoutSetup["taxInfo"];
  onSaved?: () => void;
}>) {
  const [pan, setPan] = useState("");
  const [entity, setEntity] = useState<TaxInfoInput["taxEntityType"]>(
    current.taxEntityType ?? undefined,
  );
  const [gstin, setGstin] = useState(current.gstin ?? "");
  const [msme, setMsme] = useState<NonNullable<TaxInfoInput["msmeStatus"]>>(
    current.msmeStatus,
  );
  const [udyam, setUdyam] = useState(current.udyamNumber ?? "");
  const [agreement, setAgreement] = useState(current.msmeWrittenAgreement);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const invalidate = usePayoutSetupInvalidation(consultantId);
  const refusalToast = useRefusalToast();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: saveTaxInfo,
    onSuccess: async () => {
      await invalidate();
      toast({
        title: "Tax details saved",
        description: "We keep your PAN encrypted and show only its last four.",
      });
      setPan("");
      onSaved?.();
    },
    onError: (error) => refusalToast(error, "Could not save your tax details."),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    const panValue = pan.trim().toUpperCase();
    if (!current.panMasked && !panValue) {
      setFieldError("Enter your PAN.");
      return;
    }
    if (panValue && !PAN.test(panValue)) {
      setFieldError("A PAN is ten characters, like ABCDE1234F.");
      return;
    }
    if (!entity) {
      setFieldError("Tell us what kind of entity you file as.");
      return;
    }
    const gstinValue = gstin.trim().toUpperCase();
    if (gstinValue && !GSTIN.test(gstinValue)) {
      setFieldError("A GSTIN is fifteen characters, like 27ABCDE1234F1Z5.");
      return;
    }
    mutation.mutate({
      ...(panValue ? { panNumber: panValue } : {}),
      taxEntityType: entity,
      ...(gstinValue ? { gstin: gstinValue } : {}),
      msmeStatus: msme,
      udyamNumber: msme === "NONE" ? null : udyam.trim() || null,
      msmeWrittenAgreement: agreement,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Tax details">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pan-input">
            PAN{current.panMasked ? ` (on file: ${current.panMasked})` : ""}
          </Label>
          <Input
            id="pan-input"
            value={pan}
            onChange={(e) => setPan(e.target.value.toUpperCase())}
            placeholder={
              current.panMasked ? "Leave blank to keep" : "ABCDE1234F"
            }
            autoComplete="off"
            maxLength={10}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="entity">You file as</Label>
          <select
            id="entity"
            className={selectClass}
            value={entity ?? ""}
            onChange={(e) =>
              setEntity(
                (e.target.value || undefined) as TaxInfoInput["taxEntityType"],
              )
            }
          >
            <option value="">Choose one</option>
            {ENTITY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="gstin-input">GSTIN (only if registered)</Label>
          <Input
            id="gstin-input"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            placeholder="27ABCDE1234F1Z5"
            autoComplete="off"
            maxLength={15}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="msme">MSME registration</Label>
          <select
            id="msme"
            className={selectClass}
            value={msme}
            onChange={(e) =>
              setMsme(e.target.value as NonNullable<TaxInfoInput["msmeStatus"]>)
            }
          >
            {MSME_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {msme !== "NONE" && (
          <div className="space-y-1.5">
            <Label htmlFor="udyam">Udyam number</Label>
            <Input
              id="udyam"
              value={udyam}
              onChange={(e) => setUdyam(e.target.value.toUpperCase())}
              placeholder="UDYAM-XX-00-0000000"
              maxLength={19}
            />
          </div>
        )}
      </div>
      {msme !== "NONE" && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={agreement}
            onChange={(e) => setAgreement(e.target.checked)}
          />
          <span>
            I have a written agreement with Familiarise on payment terms.
            <span className="block text-xs text-muted-foreground">
              Sets the MSMED payment deadline (15 days without one, up to 45
              with).
            </span>
          </span>
        </label>
      )}
      {fieldError && (
        <p role="alert" className="text-sm text-red-600">
          {fieldError}
        </p>
      )}
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Saving…" : "Save tax details"}
      </Button>
    </form>
  );
}
