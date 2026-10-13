import "server-only";

import {
  QueryClient,
  dehydrate,
  type DehydratedState,
} from "@tanstack/react-query";

import {
  LIBRARY_READ_FILTERS,
  libraryQueryString,
} from "@/lib/library/library-query";
import { timedLibraryRead } from "@/lib/library/timed-read";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Seeds page 1 of an unfiltered Library, the view a visit opens, so the list
 * renders without a client round trip; a filtered URL still fetches on the client.
 */
export async function seedLibraryPage(args: {
  name: string;
  queryKey: readonly unknown[];
  fixedParams?: Record<string, string>;
  searchParams: SearchParams;
  skip?: boolean;
  read: () => Promise<unknown>;
}): Promise<DehydratedState> {
  const queryClient = new QueryClient();
  const filtered = ["q", "page", ...LIBRARY_READ_FILTERS].some(
    (key) => args.searchParams[key] !== undefined,
  );
  if (!filtered && !args.skip) {
    const qs = libraryQueryString(args.fixedParams, {
      q: "",
      page: 1,
      filters: {},
    });
    await queryClient.prefetchQuery({
      queryKey: [...args.queryKey, qs],
      queryFn: () => timedLibraryRead(args.name, args.read),
    });
  }
  return dehydrate(queryClient);
}
