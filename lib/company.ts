/**
 * The registered office of the legal entity, split the way the e-invoice
 * (IRP) schema wants it. `stateCode` is the numeric GST state code.
 */
export const REGISTERED_OFFICE = {
  line1: "T 3 Fl 701, M3M Merlin, Main Gujjar Rd Sec 67",
  city: "Gurgaon",
  district: "Gurgaon",
  pincode: "122018",
  state: "Haryana",
  stateCode: "06",
} as const;

/**
 * The legal entity behind Familiarise: the public pages, the footer, and the
 * supplier on tax invoices, credit notes and IRP payloads all read it here.
 */
export const COMPANY_INFO = {
  name: "Practitionist (OPC) Private Limited",
  cin: "U62012HR2026OPC146217",
  registeredAddress: `${REGISTERED_OFFICE.line1}, ${REGISTERED_OFFICE.city}, ${REGISTERED_OFFICE.district} - ${REGISTERED_OFFICE.pincode}, ${REGISTERED_OFFICE.state}, India`,
  // A literal, not an env read: the client bundle never sees non-public env, so
  // an env-driven value rendered a different mailbox on the server and client.
  email: "support@practitionist.com",
  // Empty until a support line exists; every row that prints it is omitted.
  phone: "",
  jurisdiction: "Haryana, India",
  // Empty until a named officer is appointed; /grievance omits the row.
  grievanceOfficerName: "",
} as const;

/** Customer support mailbox: the default Reply-To and the base of the two inboxes below. */
export const SUPPORT_EMAIL = "support@familiarisenow.com";
/** Where /contactus inquiries are delivered. */
export const CONTACT_INBOX_ADDRESS = SUPPORT_EMAIL;
/** Supplier contact printed on tax invoices and credit notes. */
export const BILLING_EMAIL = SUPPORT_EMAIL;
/** Postal line for email footers and newsletter compliance. */
export const COMPANY_POSTAL_ADDRESS = COMPANY_INFO.registeredAddress;

/** Resend sending domains: transactional and newsletter reputations stay apart. */
export const EMAIL_TRANSACTIONAL_DOMAIN = "mail.familiarisenow.com";
export const EMAIL_NEWSLETTER_DOMAIN = "news.familiarisenow.com";

/** Series prefix of consumer invoice and credit-note numbers; Rule 46 caps the whole number at 16 characters. */
export const PLATFORM_INVOICE_PREFIX = "FAM";
