/**
 * The root not-found is prerendered as `/_not-found`, so its chrome is drawn,
 * while the browser hydrates it on a /dashboard URL that hides the chrome.
 * The chrome decides on the server-rendered path while hydrating, so the first
 * client render matches, then hides once hydrated.
 */
import "../fixtures/text-encoding";
import * as React from "react";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import Footer from "@/components/Footer";
import HeaderSpacer from "@/components/HeaderSpacer";
import NotFound from "@/app/not-found";
import { ChromePathMarker } from "@/lib/navigation/use-chrome-pathname";

let mockPathname = "/_not-found";
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  usePathname: () => mockPathname,
}));

function Page({ marker }: Readonly<{ marker: boolean }>) {
  return (
    <>
      {marker ? <ChromePathMarker /> : null}
      <HeaderSpacer />
      <NotFound />
      <Footer />
    </>
  );
}

async function hydrateOnDashboard(marker: boolean) {
  mockPathname = "/_not-found";
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Page marker={marker} />);
  document.body.appendChild(container);
  const serverHtml = container.innerHTML;

  mockPathname = "/dashboard/x";
  const errors: unknown[] = [];
  const consoleError = jest
    .spyOn(console, "error")
    .mockImplementation((...args) => errors.push(args[0]));
  await act(async () => {
    hydrateRoot(container, <Page marker={marker} />, {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  consoleError.mockRestore();
  const settledHtml = container.innerHTML;
  container.remove();
  return { serverHtml, errors, settledHtml };
}

it("hydrates the prerendered not-found on a dashboard URL without a mismatch, then hides the chrome", async () => {
  const { serverHtml, errors, settledHtml } = await hydrateOnDashboard(true);
  expect(serverHtml).toContain("<footer");
  expect(errors).toEqual([]);
  expect(settledHtml).toContain("Page not found");
  expect(settledHtml).not.toContain("<footer");
});

it("without the marker the same hydration mismatches", async () => {
  const { errors } = await hydrateOnDashboard(false);
  expect(errors.length).toBeGreaterThan(0);
});
