import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import FeaturedCarousel from "@/app/explore/programs/components/FeaturedCarousel";
import type { Program } from "@/lib/explore/programs";

jest.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../hooks/useCurrency", () => ({
  useCurrency: () => ({ formatPrice: (price: number) => `₹${price}` }),
}));

const program = (id: string): Program =>
  ({
    id,
    type: "class",
    title: `Program ${id}`,
    description: `Description ${id}`,
    imageUrl: `/program-${id}.jpg`,
    price: 100,
  }) as Program;

describe("FeaturedCarousel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps the selected slide within bounds when the program list shrinks", () => {
    const first = program("first");
    const second = program("second");
    const third = program("third");

    act(() => root.render(<FeaturedCarousel programs={[first, second, third]} />));
    act(() => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Go to slide 3"]')
        ?.click();
    });
    expect(host.querySelector("a")?.getAttribute("aria-label")).toBe(
      "View details for Program third",
    );

    act(() => root.render(<FeaturedCarousel programs={[first, second]} />));
    expect(host.querySelector("a")?.getAttribute("aria-label")).toBe(
      "View details for Program second",
    );

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="Next"]')?.click();
    });
    expect(host.querySelector("a")?.getAttribute("aria-label")).toBe(
      "View details for Program first",
    );
  });
});
