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
  REQUEST_AGAIN_LOCK_CODES,
  RequestAgainAnswerSchema,
  requestAgainPath,
  type RequestAgainPaymentRow,
} from "@/lib/booking/request-again-rules";

const isLockCode = (code: string) =>
  (REQUEST_AGAIN_LOCK_CODES as readonly string[]).includes(code);

/**
 * Every "Request again" / "Book again" that leads to a new booking. With an order
 * still PENDING it is a button: past that order's window it warns, closes it
 * through the request-again route and navigates only once the route says it is
 * closed; inside the window it navigates. Otherwise it is a plain link.
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
        const { code, error } = answer.data;
        setNotice(code === "ALREADY_PAID" ? REQUEST_AGAIN_ALREADY_PAID : error);
        // A busy lock changed nothing, so there is nothing to reload.
        if (!isLockCode(code)) router.refresh();
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

  // While an order is PENDING the control has no href, so no browser shortcut skips the close.
  const orderOpen =
    !!appointmentId && payments.some((p) => p.paymentStatus === "PENDING");
  return (
    <>
      {orderOpen ? (
        <Button
          variant={variant}
          size={size}
          className={className}
          onClick={() => {
            // Decided at the click: a window can close after the page rendered.
            if (!openOrderPastWindow(payments, new Date())) {
              router.push(href);
              return;
            }
            setNotice(null);
            setOpen(true);
          }}
        >
          {children}
        </Button>
      ) : (
        <Button variant={variant} size={size} className={className} asChild>
          <Link href={href}>{children}</Link>
        </Button>
      )}
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
