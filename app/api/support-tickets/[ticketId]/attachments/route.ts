import { retiredSupportEndpoint } from "@/lib/api/retired-endpoint";

/**
 * The pre-cutover ticket attachment route. The canonical case graph carries
 * its attachments (SupportCaseAttachment), and this route would write to the
 * drained SupportTicket table — so it answers 410 like its siblings.
 */
export function GET() {
  return retiredSupportEndpoint();
}

export function POST() {
  return retiredSupportEndpoint();
}

export function DELETE() {
  return retiredSupportEndpoint();
}
