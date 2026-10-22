import { notFound } from "next/navigation";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { EvidenceInbox } from "@/components/support/EvidenceInbox";
import { ReportHistory } from "@/components/dashboard/shared/ReportHistory";
import { ProductFeedbackPage } from "@/components/dashboard/shared/feedback/ProductFeedbackPage";

export function HelpSectionPage({
  section,
  basePath,
}: Readonly<{ section: string; basePath: string }>) {
  if (section === "feedback") return <ProductFeedbackPage />;
  if (section === "reports")
    return (
      <>
        <PageHeader
          headingLevel={2}
          title="Reports & appeals"
          description="Track your reports and review decisions affecting your content or account."
        />
        <ReportHistory />
      </>
    );
  if (section === "evidence")
    return (
      <>
        <PageHeader
          headingLevel={2}
          title="Evidence requests"
          description="Information the platform investigation team has asked you to provide."
        />
        <EvidenceInbox detailBase={`${basePath}/support/evidence`} />
      </>
    );
  notFound();
}
