"use client";

import * as React from "react";

interface AutoFocusHandlers {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onFocusCapture?: React.FocusEventHandler<HTMLDivElement>;
}

/**
 * A menu item unmounts with its menu, so an opener inside a Radix menu stands
 * for that menu's trigger (named by the menu's `aria-labelledby`).
 */
function resolveOpener(element: HTMLElement): HTMLElement {
  let current = element;
  for (let menu = current.closest<HTMLElement>('[role="menu"]'); menu;) {
    const labelledBy = menu.getAttribute("aria-labelledby");
    const trigger =
      (labelledBy && document.getElementById(labelledBy)) ||
      document.querySelector<HTMLElement>(
        '[aria-haspopup="menu"][aria-expanded="true"]',
      );
    if (!(trigger instanceof HTMLElement) || trigger === current) break;
    current = trigger;
    menu = current.closest<HTMLElement>('[role="menu"]');
  }
  return current;
}

/**
 * Radix returns focus only to its Trigger, so a dialog opened from state lost
 * focus to <body> on close. This remembers what had focus when the dialog
 * opened and returns there when nothing else took focus: Radix focuses its
 * Trigger synchronously after `onCloseAutoFocus`, so the check runs a
 * microtask later and a Trigger keeps its own behaviour. A caller that calls
 * `preventDefault()` keeps control. Radix skips `onOpenAutoFocus` when a child
 * has `autoFocus`, so the first focus arriving from outside records it too.
 */
export function useReturnFocus({
  onOpenAutoFocus,
  onCloseAutoFocus,
  onFocusCapture,
}: AutoFocusHandlers): Required<AutoFocusHandlers> {
  const openerRef = React.useRef<HTMLElement | null>(null);

  const handleOpen = React.useCallback(
    (event: Event) => {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && active !== document.body
          ? resolveOpener(active)
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

  const handleFocusCapture = React.useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      onFocusCapture?.(event);
      const from = event.relatedTarget;
      if (
        !openerRef.current &&
        from instanceof HTMLElement &&
        !event.currentTarget.contains(from)
      ) {
        openerRef.current = resolveOpener(from);
      }
    },
    [onFocusCapture],
  );

  return {
    onOpenAutoFocus: handleOpen,
    onCloseAutoFocus: handleClose,
    onFocusCapture: handleFocusCapture,
  };
}
