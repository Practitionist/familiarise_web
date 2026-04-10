"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { orgInfoSchema, type OrgInfoFormData } from "../schemas";
import type { StepProps } from "../types";

const INDUSTRIES = [
  "Education",
  "Technology",
  "Healthcare",
  "Finance",
  "Legal",
  "Government",
  "Non-profit",
  "Manufacturing",
  "Consulting",
  "Other",
];

const SIZE_BUCKETS = [
  { value: "SMALL_1_50", label: "1-50 employees" },
  { value: "MEDIUM_51_200", label: "51-200 employees" },
  { value: "LARGE_201_1000", label: "201-1000 employees" },
  { value: "ENTERPRISE_1000_PLUS", label: "1000+ employees" },
];

export function OrgInfoStep({ onNext, initialData, isSubmitting }: StepProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<OrgInfoFormData>({
    resolver: zodResolver(orgInfoSchema),
    defaultValues: {
      name: initialData.name ?? "",
      billingEmail: initialData.billingEmail ?? "",
      description: initialData.description ?? "",
      industry: initialData.industry ?? "",
      sizeBucket: initialData.sizeBucket ?? "",
      website: initialData.website ?? "",
    },
  });

  const onSubmit = (data: OrgInfoFormData) => onNext(data);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="name">Organization name *</Label>
        <Input id="name" {...register("name")} placeholder="Acme School" />
        {errors.name && (
          <p className="text-sm text-red-500">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="billingEmail">Billing email *</Label>
        <Input
          id="billingEmail"
          type="email"
          {...register("billingEmail")}
          placeholder="billing@acme.edu"
        />
        {errors.billingEmail && (
          <p className="text-sm text-red-500">{errors.billingEmail.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          {...register("description")}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm min-h-20"
          placeholder="A short description of your organization"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Industry</Label>
          <Select
            value={watch("industry")}
            onValueChange={(v) => setValue("industry", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select industry" />
            </SelectTrigger>
            <SelectContent>
              {INDUSTRIES.map((ind) => (
                <SelectItem key={ind} value={ind}>
                  {ind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Size</Label>
          <Select
            value={watch("sizeBucket")}
            onValueChange={(v) => setValue("sizeBucket", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select size" />
            </SelectTrigger>
            <SelectContent>
              {SIZE_BUCKETS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="website">Website</Label>
        <Input
          id="website"
          type="url"
          {...register("website")}
          placeholder="https://example.com"
        />
        {errors.website && (
          <p className="text-sm text-red-500">{errors.website.message}</p>
        )}
      </div>

      <div className="flex justify-end pt-4">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating organization…" : "Next"}
        </Button>
      </div>
    </form>
  );
}
