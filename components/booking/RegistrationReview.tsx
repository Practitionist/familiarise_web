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
        className="h-12 w-full rounded-xl"
        onClick={openReview}
      >
        Review registration
      </Button>
      {mobileAction && (
        <div className="mobile-booking-bar lg:!hidden">
          <span className="text-sm font-semibold">{price}</span>
          <Button
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={dialogId}
            className="rounded-xl"
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
        overlayClassName="z-[1100]"
        className="booking-dialog z-[1101] sm:max-w-xl"
      >
        <DialogHeader className="p-6 pr-12">
          <DialogTitle className="text-2xl">
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
        <div className="booking-footer">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Back
          </Button>
          <Button onClick={onContinue}>{label}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
