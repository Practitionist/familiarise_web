import "server-only";

import prisma from "@/lib/prisma";
import {
  documentWriteRefusal,
  resolveDocumentParty,
  type DocumentBookingKind,
  type DocumentPartyRole,
} from "./document-party";
import { MAX_DOCS_PER_APPOINTMENT } from "./document-review";
import {
  buildThreadViews,
  threadRowSelect,
  type ThreadView,
} from "./thread-view";

/** The Documents workspace read: booking facts, limits and server-built threads. */
export interface DocumentWorkspace {
  booking: {
    id: string;
    kind: DocumentBookingKind;
    title: string;
    viewerRole: DocumentPartyRole;
    learnerName: string;
    expertName: string;
    organizationName: string | null;
    terminal: boolean;
    terminalAt: string | null;
    confirmed: boolean;
    /** Why writes are refused, or null when the viewer may upload, review and reply. */
    readOnlyReason:
      | "APPOINTMENT_TERMINAL"
      | "BOOKING_NOT_CONFIRMED"
      | "UPLOAD_WINDOW_CLOSED"
      | null;
    uploadWindow: { open: boolean; closesAt: string | null };
    keptUntil: string | null;
  };
  limits: { documents: { used: number; max: number } };
  threads: ThreadView[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function readDocumentWorkspace(
  appointmentId: string,
  userId: string,
): Promise<DocumentWorkspace | null> {
  const party = await resolveDocumentParty(prisma, appointmentId, userId);
  if (!party) return null;
  const { booking } = party;

  const rows = await prisma.appointmentDocument.findMany({
    where: { appointmentId, deletedAt: null },
    select: threadRowSelect,
    orderBy: { versionNo: "asc" },
  });
  const readOnlyReason = documentWriteRefusal(booking);
  const expired =
    booking.keptUntil !== null && booking.keptUntil.getTime() <= Date.now();
  const threads = expired
    ? []
    : buildThreadViews(rows, {
        viewerRole: party.role,
        writable: readOnlyReason === null,
      });

  return {
    booking: {
      id: booking.id,
      kind: booking.kind,
      title: booking.title,
      viewerRole: party.role,
      learnerName: booking.learner.name,
      expertName: booking.expert.name,
      organizationName: booking.organizationName,
      terminal: booking.terminal,
      terminalAt: iso(booking.terminalAt),
      confirmed: booking.confirmed,
      readOnlyReason,
      uploadWindow: {
        open: booking.uploadWindowOpen,
        closesAt: iso(booking.uploadWindowClosesAt),
      },
      keptUntil: iso(booking.keptUntil),
    },
    limits: {
      documents: {
        used: rows.filter((r) => r.rootDocumentId === null).length,
        max: MAX_DOCS_PER_APPOINTMENT,
      },
    },
    threads,
  };
}
