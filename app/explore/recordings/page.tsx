import { permanentRedirect } from "next/navigation";
import {
  replaysIndexHref,
  type RawSearchParams,
} from "@/lib/explore/products-tabs";

export default async function ExploreRecordingsRedirect({
  searchParams,
}: Readonly<{ searchParams: Promise<RawSearchParams> }>) {
  permanentRedirect(replaysIndexHref(await searchParams));
}
