/**
 * @jest-environment node
 */

/**
 * An unknown path under a back-office tree has its own not-found inside the
 * operator shell: static text, and no second <main> inside the shell's.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import BackofficeNotFound from "@/app/dashboard/(backoffice)/[tree]/not-found";

it("renders a static not-found without a nested <main>", () => {
  const html = renderToStaticMarkup(<BackofficeNotFound />);
  expect(html).toContain("Page not found");
  expect(html).not.toContain("<main");
});
