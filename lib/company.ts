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
  phone: process.env.NEXT_PUBLIC_SUPPORT_PHONE?.trim() || "",
  jurisdiction:
    process.env.NEXT_PUBLIC_COMPANY_JURISDICTION?.trim() || "Haryana, India",
} as const;
