"use client";

/**
 * Contact form wired to POST /api/contact with category deep-linking and
 * statutory acknowledgement SLA copy.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2 } from "lucide-react";
import { ACK_PROMISE_COPY, INQUIRY_CATEGORIES } from "../constants";

type FieldErrors = Partial<Record<string, string[]>>;

const EMPTY = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  subject: "",
  message: "",
  category: "",
  website: "", // honeypot
};

export function ContactForm() {
  const searchParams = useSearchParams();
  const requestedCategory = searchParams.get("category") ?? "";
  const validCategory = INQUIRY_CATEGORIES.some(
    (c) => c.value === requestedCategory,
  )
    ? requestedCategory
    : "";

  const [values, setValues] = useState(() => ({
    ...EMPTY,
    category: validCategory,
  }));
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [trackingRef, setTrackingRef] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  useEffect(() => {
    setValues((prev) => ({ ...prev, category: validCategory }));
  }, [validCategory]);

  const set = (key: keyof typeof EMPTY) => (value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    setFormError(null);
    setFieldErrors({});
    setTrackingRef(null);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const body = (await res.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: FieldErrors;
        referenceNumber?: string;
      } | null;

      if (!res.ok) {
        setFieldErrors(body?.fieldErrors ?? {});
        setFormError(
          body?.error ??
            "We could not send your message. Please try again in a moment.",
        );
        setStatus("idle");
        return;
      }

      setTrackingRef(body?.referenceNumber ?? null);
      setValues(EMPTY);
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
        <p className="text-lg font-semibold">Message sent</p>
        {trackingRef && (
          <p className="rounded-md bg-muted px-3 py-1 font-mono text-xs text-foreground">
            Tracking reference: {trackingRef}
          </p>
        )}
        <p className="text-sm text-muted-foreground max-w-sm">
          Thanks for reaching out. We acknowledge and reply {ACK_PROMISE_COPY}{" "}
          to the email address you gave us.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setTrackingRef(null);
            setStatus("idle");
          }}
        >
          Send another message
        </Button>
      </div>
    );
  }

  const err = (k: string) => fieldErrors[k]?.[0];
  const sending = status === "sending";

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="first-name">
            First name <span className="text-red-500">*</span>
          </Label>
          <Input
            id="first-name"
            name="firstName"
            placeholder="Enter your first name"
            value={values.firstName}
            onChange={(e) => set("firstName")(e.target.value)}
            aria-invalid={!!err("firstName")}
            aria-describedby={err("firstName") ? "first-name-error" : undefined}
            required
          />
          {err("firstName") && (
            <p id="first-name-error" className="text-xs text-red-600">
              {err("firstName")}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="last-name">
            Last name <span className="text-red-500">*</span>
          </Label>
          <Input
            id="last-name"
            name="lastName"
            placeholder="Enter your last name"
            value={values.lastName}
            onChange={(e) => set("lastName")(e.target.value)}
            aria-invalid={!!err("lastName")}
            aria-describedby={err("lastName") ? "last-name-error" : undefined}
            required
          />
          {err("lastName") && (
            <p id="last-name-error" className="text-xs text-red-600">
              {err("lastName")}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">
          Email <span className="text-red-500">*</span>
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          placeholder="Enter your email"
          value={values.email}
          onChange={(e) => set("email")(e.target.value)}
          aria-invalid={!!err("email")}
          aria-describedby={err("email") ? "email-error" : undefined}
          required
        />
        {err("email") && (
          <p id="email-error" className="text-xs text-red-600">
            {err("email")}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">Phone (optional)</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          placeholder="Enter your phone number"
          value={values.phone}
          onChange={(e) => set("phone")(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="subject">
          Subject <span className="text-red-500">*</span>
        </Label>
        <Input
          id="subject"
          name="subject"
          placeholder="What is this regarding?"
          value={values.subject}
          onChange={(e) => set("subject")(e.target.value)}
          aria-invalid={!!err("subject")}
          aria-describedby={err("subject") ? "subject-error" : undefined}
          required
        />
        {err("subject") && (
          <p id="subject-error" className="text-xs text-red-600">
            {err("subject")}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="message">
          Message <span className="text-red-500">*</span>
        </Label>
        <Textarea
          className="min-h-[150px]"
          id="message"
          name="message"
          placeholder="Enter your message"
          value={values.message}
          onChange={(e) => set("message")(e.target.value)}
          aria-invalid={!!err("message")}
          aria-describedby={err("message") ? "message-error" : undefined}
          required
        />
        {err("message") && (
          <p id="message-error" className="text-xs text-red-600">
            {err("message")}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="category">Inquiry Type</Label>
        <select
          id="category"
          name="category"
          className="w-full px-3 py-2 border border-border rounded-md bg-background"
          value={values.category}
          onChange={(e) => set("category")(e.target.value)}
        >
          {INQUIRY_CATEGORIES.map((category) => (
            <option key={category.value} value={category.value}>
              {category.label}
            </option>
          ))}
        </select>
      </div>

      {/* Honeypot — hidden from people, irresistible to bots. */}
      <div aria-hidden className="hidden">
        <Label htmlFor="website">Website</Label>
        <Input
          id="website"
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
          "Send Message"
        )}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        We acknowledge and reply {ACK_PROMISE_COPY}.
      </p>
    </form>
  );
}
