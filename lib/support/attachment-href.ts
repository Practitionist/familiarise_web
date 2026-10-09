/** App route that authorises the caller and redirects to a short-lived signed URL. */
export function supportAttachmentHref(
  ticketId: string,
  attachmentId: string,
): string {
  return `/api/support-tickets/${ticketId}/attachments/${attachmentId}`;
}

/** Rows keep their stored URL in the DB; callers only ever see the app route. */
export function withSupportAttachmentHrefs<
  T extends { id: string; ticketId: string; fileUrl: string },
>(rows: T[]): T[] {
  return rows.map((row) => ({
    ...row,
    fileUrl: supportAttachmentHref(row.ticketId, row.id),
  }));
}
