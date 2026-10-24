import type { ReactNode } from "react";
import { COMPANY_INFO } from "@/lib/company";
import { getMailtoLink, getTelLink } from "./constants";

const LINK_CLASS =
  "font-medium text-foreground underline underline-offset-4 hover:no-underline";

/** The legal-entity block shared by the policy pages; rows without a value are omitted. */
export function CompanyDetails({
  children,
}: Readonly<{ children?: ReactNode }>) {
  return (
    <div className="bg-muted p-4 rounded-lg mt-4">
      <p>
        <strong>Company Name:</strong> {COMPANY_INFO.name}
      </p>
      <p>
        <strong>CIN:</strong> {COMPANY_INFO.cin}
      </p>
      <p>
        <strong>Registered Office:</strong> {COMPANY_INFO.registeredAddress}
      </p>
      <p>
        <strong>Email:</strong>{" "}
        <a href={getMailtoLink()} className={LINK_CLASS}>
          {COMPANY_INFO.email}
        </a>
      </p>
      {COMPANY_INFO.phone ? (
        <p>
          <strong>Phone:</strong>{" "}
          <a href={getTelLink()} className={LINK_CLASS}>
            {COMPANY_INFO.phone}
          </a>
        </p>
      ) : null}
      {children}
    </div>
  );
}
