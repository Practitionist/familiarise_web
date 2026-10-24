/** The legal entity behind Familiarise, as shown on the public pages and in the footer. */
export const COMPANY_INFO = {
  name: "Practitionist (OPC) Private Limited",
  cin: "U62012HR2026OPC146217",
  registeredAddress:
    "T 3 Fl 701, M3M Merlin, Main Gujjar Rd Sec 67, Gurgaon, Gurgaon - 122018, Haryana, India",
  // A literal, not an env read: the client bundle never sees non-public env, so
  // an env-driven value rendered a different mailbox on the server and client.
  email: "support@practitionist.com",
  phone: process.env.NEXT_PUBLIC_SUPPORT_PHONE?.trim() || "",
  jurisdiction:
    process.env.NEXT_PUBLIC_COMPANY_JURISDICTION?.trim() || "Haryana, India",
} as const;
