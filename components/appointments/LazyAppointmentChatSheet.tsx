"use client";

import dynamic from "next/dynamic";
import type { AppointmentChatTarget } from "@/lib/appointments/adapter";

// Loaded on first open so the Stream chat SDK stays off the appointment page bundles.
const AppointmentChatSheet = dynamic(
  () =>
    import("./detail/AppointmentChatSheet").then((m) => m.AppointmentChatSheet),
  { ssr: false },
);

export function LazyAppointmentChatSheet({
  target,
  onClose,
}: Readonly<{ target: AppointmentChatTarget | null; onClose: () => void }>) {
  return target ? (
    <AppointmentChatSheet target={target} onClose={onClose} />
  ) : null;
}
