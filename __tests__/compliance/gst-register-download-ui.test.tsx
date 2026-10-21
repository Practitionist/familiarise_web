/**
 * @jest-environment jsdom
 */

/**
 * The compliance page's GST register tab hands the operator a link, and the
 * link's query parameter is the whole contract with the route: a month that
 * does not reach the route as `period=YYYY-MM` is a 400, and the operator
 * gets nothing.
 */

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { GstRegisterDownload } from "../../app/dashboard/(backoffice)/[tree]/compliance/GstRegisterDownload";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** React reads the DOM value through its own setter, so the native one is used. */
function setMonth(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("links the download to the month the operator picked", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<GstRegisterDownload />));

  const input = container.querySelector<HTMLInputElement>(
    "#gst-register-period",
  );
  expect(input).not.toBeNull();

  await act(async () => setMonth(input!, "2026-10"));

  const link = container.querySelector<HTMLAnchorElement>("a");
  expect(link?.getAttribute("href")).toBe(
    "/api/admin/compliance/gst-register?period=2026-10",
  );

  act(() => root.unmount());
  container.remove();
});

it("offers no download until a month is picked", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<GstRegisterDownload />));

  expect(container.querySelector("a")).toBeNull();
  const button = container.querySelector("button");
  expect(button?.disabled).toBe(true);

  act(() => root.unmount());
  container.remove();
});
