"use client";

import { useEffect, useRef, useState } from "react";
import { byCodeUnit } from "@/lib/scheduling/code-unit-order";

/**
 * A pick the latest read proves gone is painted "Just taken" for exactly one
 * committed render, then handed to `onDrop` (deselect, announce) and
 * cleared. `staleKeys` is recomputed by the caller on every render from the
 * current picks and the current data; only a change in that set re-arms it.
 * Returns the keys to paint "Just taken" this render.
 */
export function useJustTaken(
  staleKeys: readonly string[],
  onDrop: (keys: string[]) => void,
): ReadonlySet<string> {
  const [painted, setPainted] = useState<string[]>([]);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  const signature = [...staleKeys].sort(byCodeUnit).join("|");
  useEffect(() => {
    if (signature === "") return;
    setPainted((current) =>
      current.length > 0 ? current : signature.split("|"),
    );
  }, [signature]);

  useEffect(() => {
    if (painted.length === 0) return;
    onDropRef.current(painted);
    setPainted([]);
  }, [painted]);

  return new Set(painted);
}
