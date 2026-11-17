"use client";

import * as React from "react";

interface AutoFocusHandlers {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Radix returns focus only to its Trigger, so a dialog opened from state lost
 * focus to <body> on close. This remembers what had focus when the dialog
 * opened and returns there when nothing else took focus: Radix focuses its
 * Trigger synchronously after `onCloseAutoFocus`, so the check runs a
 * microtask later and a Trigger keeps its own behaviour. A caller that calls
 * `preventDefault()` keeps control.
 */
export function useReturnFocus({
  onOpenAutoFocus,
  onCloseAutoFocus,
}: AutoFocusHandlers): Required<AutoFocusHandlers> {
  const openerRef = React.useRef<HTMLElement | null>(null);

  const handleOpen = React.useCallback(
    (event: Event) => {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      onOpenAutoFocus?.(event);
    },
    [onOpenAutoFocus],
  );

  const handleClose = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event);
      const opener = openerRef.current;
      openerRef.current = null;
      if (event.defaultPrevented || !opener) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        const lost = active === null || active === document.body;
        if (lost && opener.isConnected) opener.focus();
      });
    },
    [onCloseAutoFocus],
  );

  return { onOpenAutoFocus: handleOpen, onCloseAutoFocus: handleClose };
}
