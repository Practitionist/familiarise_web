/**
 * @jest-environment node
 */
import {
  isPageTranslated,
  isTranslateDomMutationNoise,
} from "../../lib/observability/translate-dom-noise";

const removeChild = {
  exception: {
    values: [
      {
        type: "NotFoundError",
        value:
          "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      },
    ],
  },
};

describe("translate DOM mutation noise", () => {
  it("drops removeChild NotFoundError only when the page is translated", () => {
    expect(isTranslateDomMutationNoise(removeChild, true)).toBe(true);
    expect(isTranslateDomMutationNoise(removeChild, false)).toBe(false);
  });

  it("drops insertBefore but keeps other errors even when translated", () => {
    const insert = {
      exception: {
        values: [
          {
            type: "NotFoundError",
            value: "Failed to execute 'insertBefore' on 'Node': nope",
          },
        ],
      },
    };
    expect(isTranslateDomMutationNoise(insert, true)).toBe(true);
    expect(
      isTranslateDomMutationNoise(
        { exception: { values: [{ type: "TypeError", value: "x" }] } },
        true,
      ),
    ).toBe(false);
    expect(isTranslateDomMutationNoise({}, true)).toBe(false);
  });

  it("keeps an event whose linked chain holds a distinct application error", () => {
    const mixed = {
      exception: {
        values: [
          ...removeChild.exception.values,
          { type: "TypeError", value: "Cannot read properties of undefined" },
        ],
      },
    };
    expect(isTranslateDomMutationNoise(mixed, true)).toBe(false);
    expect(
      isTranslateDomMutationNoise({ exception: { values: [] } }, true),
    ).toBe(false);
  });

  it("detects the translated-ltr/rtl class on the root element", () => {
    expect(
      isPageTranslated({
        documentElement: { className: "a translated-ltr" },
      } as unknown as Document),
    ).toBe(true);
    expect(
      isPageTranslated({
        documentElement: { className: "dark" },
      } as unknown as Document),
    ).toBe(false);
    expect(isPageTranslated(undefined)).toBe(false);
  });
});
