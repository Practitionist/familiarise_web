"use client";

import { useRef, useState } from "react";
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

function Field({
  id,
  label,
  required,
  error,
  children,
}: Readonly<{
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label} {required && <span className="text-red-500">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}>) {
  return (
    <Field id={id} label={label}>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select one</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function DemoForm({
  initialUseCase,
}: Readonly<{ initialUseCase: DemoUseCase | "" }>) {
  const [values, setValues] = useState({ ...EMPTY, useCase: initialUseCase });
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const inFlight = useRef(false);

  const set = (key: keyof typeof EMPTY) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    // Editing a field answers its error: stale red text would say it is still wrong.
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _cleared, ...rest } = prev;
      return rest;
    });
    setFormError(null);
  };
  const err = (k: string) => fieldErrors[k]?.[0];

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // The button only disables after a re-render; a double Enter gets here first.
    if (inFlight.current) return;
    inFlight.current = true;
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
    } finally {
      inFlight.current = false;
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
  const text = (
    key: "firstName" | "lastName" | "email" | "phone" | "companyName",
    id: string,
    type: "text" | "email" | "tel" = "text",
    required = false,
  ) => (
    <Input
      id={id}
      name={key}
      type={type}
      value={values[key]}
      onChange={(e) => set(key)(e.target.value)}
      aria-invalid={!!err(key)}
      required={required}
    />
  );

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          id="demo-first-name"
          label="First name"
          required
          error={err("firstName")}
        >
          {text("firstName", "demo-first-name", "text", true)}
        </Field>
        <Field
          id="demo-last-name"
          label="Last name"
          required
          error={err("lastName")}
        >
          {text("lastName", "demo-last-name", "text", true)}
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field id="demo-email" label="Work email" required error={err("email")}>
          {text("email", "demo-email", "email", true)}
        </Field>
        <Field id="demo-phone" label="Phone (optional)">
          {text("phone", "demo-phone", "tel")}
        </Field>
      </div>

      <Field
        id="demo-company"
        label="Company or institution"
        required
        error={err("companyName")}
      >
        {text("companyName", "demo-company", "text", true)}
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SelectField
          id="demo-use-case"
          label="Interested in"
          value={values.useCase}
          onChange={set("useCase")}
          options={DEMO_USE_CASES}
        />
        <SelectField
          id="demo-team-size"
          label="Team size"
          value={values.teamSize}
          onChange={set("teamSize")}
          options={DEMO_TEAM_SIZES}
        />
        <SelectField
          id="demo-budget"
          label="Annual budget"
          value={values.budgetBand}
          onChange={set("budgetBand")}
          options={DEMO_BUDGET_BANDS}
        />
      </div>

      <Field
        id="demo-message"
        label="What are you trying to solve?"
        required
        error={err("message")}
      >
        <Textarea
          id="demo-message"
          name="message"
          className="min-h-[120px]"
          value={values.message}
          onChange={(e) => set("message")(e.target.value)}
          aria-invalid={!!err("message")}
          required
        />
      </Field>

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
