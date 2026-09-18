import { AppointmentsType } from "@prisma/client";

/** The customer word for each request type; the Mini tab used to print the
 * raw enum ("CONSULTATION") beside the full tab's "Consultation" (#1705). */
export function getRequestTypeLabel(type: AppointmentsType): string {
  switch (type) {
    case AppointmentsType.CONSULTATION:
      return "Consultation";
    case AppointmentsType.SUBSCRIPTION:
      return "Subscription";
    case AppointmentsType.WEBINAR:
      return "Webinar";
    case AppointmentsType.CLASS:
      return "Class";
    default:
      return type;
  }
}
