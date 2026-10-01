/**
 * #1527 QA wave 3 — clicking "Everyone" looked dead: the tab waited for the
 * server render before it changed. It now shows the pick at once, keeps the
 * other query params, and yields to the server's `active` once it lands.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/dashboard/organization/o1/appointments",
  useSearchParams: () => new URLSearchParams("q=acme&page=3"),
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import {
  AppointmentTabs,
  type AppointmentTab,
} from "../../app/dashboard/organization/[orgId]/appointments/AppointmentTabs";

it("Everyone shows as picked on click, then follows the server", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (active: AppointmentTab) =>
    act(() =>
      root.render(
        <AppointmentTabs active={active} available={["mine", "everyone"]} />,
      ),
    );
  const pressed = () =>
    Array.from(host.querySelectorAll("button"))
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);

  render("mine");
  const everyone = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Everyone",
  )!;
  act(() => everyone.click());

  expect(pressed()).toEqual(["Everyone"]);
  expect(replace).toHaveBeenCalledWith(
    "/dashboard/organization/o1/appointments?q=acme&tab=everyone",
    { scroll: false },
  );

  render("everyone");
  expect(pressed()).toEqual(["Everyone"]);
  act(() => root.unmount());
});
