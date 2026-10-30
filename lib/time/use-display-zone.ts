"use client";

import { useCallback, useEffect, useState } from "react";

import { canSwitchToDeviceZone, resolveGridZone } from "@/lib/time/grid-zone";

export interface DisplayZone {
  /** The zone every time on the surface is drawn in. */
  zone: string;
  usingDeviceZone: boolean;
  canSwitch: boolean;
  toggle: () => void;
}

function readDeviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Profile zone first, with a switch to the device zone. The device zone is
 * read after mount so a server render and the first client render agree.
 */
export function useDisplayZone(
  profileZone: string | null | undefined,
): DisplayZone {
  const [deviceZone, setDeviceZone] = useState<string | null>(null);
  const [usingDeviceZone, setUsingDeviceZone] = useState(false);
  useEffect(() => {
    setDeviceZone(readDeviceZone());
  }, []);
  const toggle = useCallback(() => setUsingDeviceZone((value) => !value), []);
  const device = deviceZone ?? profileZone ?? "UTC";
  const canSwitch =
    deviceZone !== null && canSwitchToDeviceZone(profileZone, deviceZone);
  return {
    zone: resolveGridZone(profileZone, device, canSwitch && usingDeviceZone),
    usingDeviceZone: canSwitch && usingDeviceZone,
    canSwitch,
    toggle,
  };
}
