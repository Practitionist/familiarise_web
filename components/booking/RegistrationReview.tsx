"use client";

import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookingSteps } from "./BookingSteps";
import { BookingSummary } from "./BookingSummary";

/** A review before the existing class/webinar checkout handoff. */
export function RegistrationReview({
  title,
  price,
  children,
  onContinue,
  label = "Continue to checkout",
  mobileAction = true,
}: Readonly<{
  title: string;
  price: string;
  children: ReactNode;
  onContinue: () => void;
  label?: string;
  mobileAction?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const openReview = (event: MouseEvent<HTMLButtonElement>) => {
    trigger.current = event.currentTarget;
    setOpen(true);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        className="h-12 w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/90"
        onClick={openReview}
      >
        Review registration
      </Button>
      {mobileAction && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-4 border-t border-border bg-background/95 p-3 backdrop-blur-md lg:!hidden">
          <span className="text-sm font-semibold text-foreground">{price}</span>
          <Button
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={dialogId}
            className="rounded-xl bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={openReview}
          >
            Review registration
          </Button>
        </div>
      )}
      <DialogContent
        id={dialogId}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
        className="z-[1101] max-h-[90dvh] w-[calc(100%-1rem)] gap-0 overflow-y-auto rounded-2xl border border-border bg-background p-0 text-foreground sm:max-w-xl"
      >
        <DialogHeader className="p-6 pr-12">
          <DialogTitle className="text-2xl text-foreground">
            Review your registration
          </DialogTitle>
          <DialogDescription>
            Check your session and price before continuing.
          </DialogDescription>
        </DialogHeader>
        <BookingSteps steps={["Session", "Review"]} current={1} />
        <div className="p-6">
          <BookingSummary title={title} price={price}>
            {children}
          </BookingSummary>
        </div>
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-4 border-t border-border bg-background px-6 py-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Back
          </Button>
          <Button onClick={onContinue}>{label}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
