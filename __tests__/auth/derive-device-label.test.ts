import { deriveDeviceLabel } from "../../lib/auth/device-label";

describe("deriveDeviceLabel (#1856)", () => {
  it("labels desktop Chrome on Windows", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows");
  });

  it("labels Safari on macOS", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      ),
    ).toBe("Safari on macOS");
  });

  it("labels Safari on iPhone (not macOS — iOS UAs embed Mac OS X)", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
  });

  it("labels Chrome on Android", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
  });

  it("prefers Edge over the embedded Chrome token", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      ),
    ).toBe("Edge on Windows");
  });

  it("labels Firefox on Linux", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
      ),
    ).toBe("Firefox on Linux");
  });

  it("labels Firefox on iOS via the FxiOS token", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
      ),
    ).toBe("Firefox on iPhone");
  });

  it("falls back to Unknown device for missing, empty and garbage input", () => {
    expect(deriveDeviceLabel(null)).toBe("Unknown device");
    expect(deriveDeviceLabel(undefined)).toBe("Unknown device");
    expect(deriveDeviceLabel("")).toBe("Unknown device");
    expect(deriveDeviceLabel("   ")).toBe("Unknown device");
    expect(deriveDeviceLabel("curl/8.0")).toBe("Unknown device");
  });

  it("returns the OS alone when the browser is unrecognized", () => {
    expect(
      deriveDeviceLabel("Mozilla/5.0 (Windows NT 10.0) CustomBrowser/1.0"),
    ).toBe("Windows");
  });
});
