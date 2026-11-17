/**
 * @jest-environment node
 */

/**
 * An unknown path under a back-office tree reaches the tree's own not-found
 * inside the operator shell: a catch-all page throws notFound(), and it can
 * shadow no real page because every other child of [tree] is a static folder.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import BackofficeNotFound from "@/app/dashboard/(backoffice)/[tree]/not-found";
import BackofficeUnknownPath from "@/app/dashboard/(backoffice)/[tree]/[...rest]/page";

const TREE = join(process.cwd(), "app/dashboard/(backoffice)/[tree]");

it("renders a static not-found without a nested <main>", () => {
  const html = renderToStaticMarkup(<BackofficeNotFound />);
  expect(html).toContain("Page not found");
  expect(html).not.toContain("<main");
});

it("the catch-all page throws notFound()", () => {
  expect(() => BackofficeUnknownPath()).toThrow(
    expect.objectContaining({ digest: expect.stringContaining("404") }),
  );
});

it("the catch-all is the only dynamic child of [tree]", () => {
  const folders = readdirSync(TREE).filter((name) =>
    statSync(join(TREE, name)).isDirectory(),
  );
  expect(folders.filter((name) => name.startsWith("["))).toEqual(["[...rest]"]);
  expect(folders.length).toBeGreaterThan(20);
});
