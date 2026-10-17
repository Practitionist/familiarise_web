import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LandingPortrait } from "@/components/home/LandingPortrait";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows intentional initials when an expert has no uploaded portrait", async () => {
  await act(async () => root.render(<LandingPortrait name="Morgan Chen" />));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("MC");
});

it("removes a failed portrait and permits a different uploaded source", async () => {
  await act(async () =>
    root.render(<LandingPortrait name="Morgan Chen" src="/portrait-a.png" />),
  );
  const image = container.querySelector("img")!;
  expect(image.alt).toBe("Morgan Chen");
  await act(async () => image.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("MC");
  await act(async () =>
    root.render(<LandingPortrait name="Morgan Chen" src="/portrait-b.png" />),
  );
  expect(container.querySelector("img")?.alt).toBe("Morgan Chen");
  expect(container.querySelector("img")?.src).toContain("portrait-b.png");
});
