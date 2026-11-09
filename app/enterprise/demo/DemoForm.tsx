"use client";

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ACK_PROMISE_COPY } from "@/app/(pages)/constants";
import {
  DEMO_BUDGET_BANDS,
  DEMO_TEAM_SIZES,
  DEMO_USE_CASES,
  demoLeadCategory,
  type DemoUseCase,
} from "./constants";

type FieldErrors = Partial<Record<string, string[]>>;

const EMPTY = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  companyName: "",
  useCase: "" as DemoUseCase | "",
  teamSize: "",
  budgetBand: "",
  message: "",
  website: "", // honeypot
};

const SELECT_CLASS =
  "w-full px-3 py-2 border border-border rounded-md bg-background";

export function DemoForm({
  initialUseCase,
}: Readonly<{ initialUseCase: DemoUseCase | "" }>) {
  const [values, setValues] = useState({ ...EMPTY, useCase: initialUseCase });
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const set = (key: keyof typeof EMPTY) => (value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const err = (k: string) => fieldErrors[k]?.[0];

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    setFormError(null);
    setFieldErrors({});

    const useCase = values.useCase || "other";
    const payload = {
      firstName: values.firstName,
      lastName: values.lastName,
      email: values.email,
      phone: values.phone,
      companyName: values.companyName,
      useCase,
      teamSize: values.teamSize || undefined,
      budgetBand: values.budgetBand || undefined,
      message: values.message,
      subject: `Demo request: ${values.companyName || "organisation"}`,
      category: demoLeadCategory(useCase),
      website: values.website,
    };

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: FieldErrors;
      } | null;
      if (!res.ok) {
        setFieldErrors(body?.fieldErrors ?? {});
        setFormError(
          body?.error ??
            "We could not send your request. Please try again in a moment.",
        );
        setStatus("idle");
        return;
      }
      setValues({ ...EMPTY, useCase: initialUseCase });
      setStatus("sent");
    } catch {
      setFormError(
        "We could not reach the server. Check your connection and try again.",
      );
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <CheckCircle2 className="h-10 w-10 text-emerald-600" aria-hidden />
        <p className="text-lg font-semibold">Request received</p>
        <p className="text-sm text-muted-foreground max-w-sm">
          Thanks. Our team acknowledges and replies {ACK_PROMISE_COPY} to the
          email address you gave us, with a proposed time for the walkthrough.
        </p>
      </div>
    );
  }

  const sending = status === "sending";

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="demo-first-name">
            First name <span className="text-red-500">*</span>
          </Label>
          <Input
            id="demo-first-name"
            name="firstName"
            value={values.firstName}
            onChange={(e) => set("firstName")(e.target.value)}
            aria-invalid={!!err("firstName")}
            required
          />
          {err("firstName") && (
            <p className="text-xs text-red-600">{err("firstName")}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-last-name">
            Last name <span className="text-red-500">*</span>
          </Label>
          <Input
            id="demo-last-name"
            name="lastName"
            value={values.lastName}
            onChange={(e) => set("lastName")(e.target.value)}
            aria-invalid={!!err("lastName")}
            required
          />
          {err("lastName") && (
            <p className="text-xs text-red-600">{err("lastName")}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="demo-email">
            Work email <span className="text-red-500">*</span>
          </Label>
          <Input
            id="demo-email"
            name="email"
            type="email"
            value={values.email}
            onChange={(e) => set("email")(e.target.value)}
            aria-invalid={!!err("email")}
            required
          />
          {err("email") && (
            <p className="text-xs text-red-600">{err("email")}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-phone">Phone (optional)</Label>
          <Input
            id="demo-phone"
            name="phone"
            type="tel"
            value={values.phone}
            onChange={(e) => set("phone")(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="demo-company">
          Company or institution <span className="text-red-500">*</span>
        </Label>
        <Input
          id="demo-company"
          name="companyName"
          value={values.companyName}
          onChange={(e) => set("companyName")(e.target.value)}
          aria-invalid={!!err("companyName")}
          required
        />
        {err("companyName") && (
          <p className="text-xs text-red-600">{err("companyName")}</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="demo-use-case">Interested in</Label>
          <select
            id="demo-use-case"
            className={SELECT_CLASS}
            value={values.useCase}
            onChange={(e) => set("useCase")(e.target.value)}
          >
            <option value="">Select one</option>
            {DEMO_USE_CASES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-team-size">Team size</Label>
          <select
            id="demo-team-size"
            className={SELECT_CLASS}
            value={values.teamSize}
            onChange={(e) => set("teamSize")(e.target.value)}
          >
            <option value="">Select one</option>
            {DEMO_TEAM_SIZES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-budget">Annual budget</Label>
          <select
            id="demo-budget"
            className={SELECT_CLASS}
            value={values.budgetBand}
            onChange={(e) => set("budgetBand")(e.target.value)}
          >
            <option value="">Select one</option>
            {DEMO_BUDGET_BANDS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="demo-message">
          What are you trying to solve? <span className="text-red-500">*</span>
        </Label>
        <Textarea
          id="demo-message"
          name="message"
          className="min-h-[120px]"
          value={values.message}
          onChange={(e) => set("message")(e.target.value)}
          aria-invalid={!!err("message")}
          required
        />
        {err("message") && (
          <p className="text-xs text-red-600">{err("message")}</p>
        )}
      </div>

      {/* Honeypot: hidden from people, irresistible to bots. */}
      <div aria-hidden className="hidden">
        <Label htmlFor="demo-website">Website</Label>
        <Input
          id="demo-website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(e) => set("website")(e.target.value)}
        />
      </div>

      {formError && (
        <p role="alert" className="text-sm text-red-600">
          {formError}
        </p>
      )}

      <Button className="w-full" type="submit" size="lg" disabled={sending}>
        {sending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Sending…
          </>
        ) : (
          "Request a demo"
        )}
      </Button>
    </form>
  );
}
