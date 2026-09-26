import { permanentRedirect } from "next/navigation";

/** Articles live only in the public Help Center (#1527); old links 308 there. */
export default function RetiredHelpPage() {
  permanentRedirect("/support");
}
