"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  openOrderPastWindow,
  REQUEST_AGAIN_ALREADY_PAID,
  REQUEST_AGAIN_WARNING,
  RequestAgainAnswerSchema,
  requestAgainPath,
  type RequestAgainPaymentRow,
} from "@/lib/booking/request-again-rules";

/**
 * Every "Request again" / "Book again" that leads to a new booking. A link that,
 * when clicked while one of `payments` is still PENDING past its window, warns,
 * closes that order through the request-again route, and navigates only once the
 * route says it is closed.
 */
export function RequestAgainButton({
  appointmentId,
  href,
  payments,
  children,
  variant = "outline",
  size = "sm",
  className,
}: Readonly<{
  appointmentId: string | null;
  href: string;
  /** The caller's own payment rows on the old booking. */
  payments: readonly RequestAgainPaymentRow[];
  children: ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function closeAndContinue(bookingId: string) {
    setBusy(true);
    try {
      const response = await fetch(requestAgainPath(bookingId), {
        method: "POST",
      });
      const answer = RequestAgainAnswerSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (response.ok && answer.success && "closed" in answer.data) {
        router.push(href);
        return;
      }
      setOpen(false);
      if (answer.success && "code" in answer.data) {
        setNotice(
          answer.data.code === "ALREADY_PAID"
            ? REQUEST_AGAIN_ALREADY_PAID
            : answer.data.error,
        );
        router.refresh();
        return;
      }
      setNotice("Could not close the earlier payment link. Try again.");
    } catch {
      setOpen(false);
      setNotice("Could not close the earlier payment link. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={variant} size={size} className={className} asChild>
        <Link
          href={href}
          onClick={(event) => {
            // Decided at the click: a window can close after the page rendered.
            if (!appointmentId || !openOrderPastWindow(payments, new Date()))
              return;
            event.preventDefault();
            setNotice(null);
            setOpen(true);
          }}
        >
          {children}
        </Link>
      </Button>
      {notice && (
        <output className="block text-xs text-muted-foreground">
          {notice}
        </output>
      )}
      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Close your earlier payment link?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {REQUEST_AGAIN_WARNING}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                // The dialog stays open until the route answers.
                event.preventDefault();
                if (appointmentId) void closeAndContinue(appointmentId);
              }}
            >
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Close it and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
