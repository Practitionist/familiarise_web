import { HelpTab } from "./HelpTab";
import { faqs } from "./questions"; // Import the FAQ data

export default function HelpPage() {
  return <HelpTab faqs={faqs} />;
}
