/**
 * @jest-environment node
 */

/**
 * Controls on the booking detail page are at least 36 px tall below `sm`
 * (`min-h-9`, reset by `sm:min-h-0`), without touching the global small
 * Button size.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const source = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8");
const growsOnPhone = (cls: string | undefined) =>
  (cls ?? "").split(/\s+/).includes("min-h-9") &&
  (cls ?? "").split(/\s+/).includes("sm:min-h-0");

describe("phone touch targets", () => {
  it("every compact ResourceSnapshot button grows on a phone", () => {
    const classes = [
      ...source("components/appointments/detail/ResourceSnapshot.tsx").matchAll(
        /className="([^"]*\bh-7\b[^"]*)"/g,
      ),
    ].map((m) => m[1]);
    expect(classes).toHaveLength(5);
    expect(classes.filter((cls) => !growsOnPhone(cls))).toEqual([]);
  });

  it("the detail page's Manage and All appointments controls grow on a phone", () => {
    const detail = source(
      "components/appointments/detail/AppointmentDetailClient.tsx",
    );
    const before = (href: string) =>
      detail.match(
        new RegExp(`className="([^"]*)"[^>]*>\\s*<Link href=\\{${href}\\}`),
      )?.[1];
    expect(growsOnPhone(before("manageHref"))).toBe(true);
    expect(growsOnPhone(before("backHref"))).toBe(true);
  });

  it("the zone switch button grows on a phone", () => {
    const cls = source("components/scheduling/ZoneSwitch.tsx").match(
      /<button[^>]*className="([^"]*)"/,
    )?.[1];
    expect(growsOnPhone(cls)).toBe(true);
  });
});
