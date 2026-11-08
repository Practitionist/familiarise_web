/**
 * @jest-environment node
 *
 * The site header is `fixed z-[1000]` (its announcement bar `z-[1001]`). A modal
 * layered below it loses its top edge, title and close button behind the
 * header, and every dialog that opened near the top of the screen did. The
 * order is pinned here so a primitive cannot drift back under the header, and so
 * what opens from inside a modal (a Select, a menu) is never hidden by it.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

/** The z-index on every line of `file` that contains `needle`. */
function layers(file: string, needle: string): number[] {
  const lines = fs
    .readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .filter((line) => line.includes(needle));
  return lines.map((line) => {
    const match = /z-\[(\d+)\]/.exec(line);
    if (!match) throw new Error(`${file}: no arbitrary z-index on "${needle}"`);
    return Number(match[1]);
  });
}

const HEADER = layers("components/Navbar.tsx", "fixed w-full z-[")[0];
const ANNOUNCEMENT = layers(
  "components/AnnouncementBar.tsx",
  "fixed top-maintenance",
)[0];

const MODALS = [
  ...layers("components/ui/dialog.tsx", '"fixed inset-0 z-'),
  ...layers("components/ui/dialog.tsx", '"fixed left-[50%] top-[50%] z-'),
  ...layers("components/ui/sheet.tsx", '"fixed inset-0 z-'),
  ...layers("components/ui/sheet.tsx", '"fixed z-'),
  ...layers("components/ui/alert-dialog.tsx", '"fixed inset-0 z-'),
  ...layers("components/ui/alert-dialog.tsx", '"fixed left-[50%] top-[50%] z-'),
];

const POPUPS = [
  ...layers("components/ui/select.tsx", '"relative z-'),
  ...layers("components/ui/dropdown-menu.tsx", "min-w-[8rem] overflow-hidden"),
  ...layers("components/ui/tooltip.tsx", "overflow-hidden rounded-md"),
  ...layers("components/ui/popover.tsx", "rounded-xl border"),
];

const TOASTS = layers("components/ui/toast.tsx", "fixed top-0 z-");

describe("overlay layer order", () => {
  it("reads the real header layers", () => {
    expect(HEADER).toBe(1000);
    expect(ANNOUNCEMENT).toBe(1001);
  });

  it("puts every modal above the site header and its announcement bar", () => {
    // Overlay and content, for each of Dialog, Sheet and AlertDialog.
    expect(MODALS).toHaveLength(6);
    for (const z of MODALS) expect(z).toBeGreaterThan(ANNOUNCEMENT);
  });

  it("puts what opens from inside a modal above the modal", () => {
    expect(POPUPS.length).toBeGreaterThanOrEqual(5);
    for (const z of POPUPS) expect(z).toBeGreaterThan(Math.max(...MODALS));
  });

  it("puts toasts above everything, so one raised under an open modal is seen", () => {
    expect(TOASTS).toHaveLength(1);
    expect(TOASTS[0]).toBeGreaterThan(Math.max(...POPUPS));
  });
});
