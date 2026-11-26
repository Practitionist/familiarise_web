/**
 * @jest-environment node
 */

// Refund is unique only on dedupeKey, and a sweep's cron lock can expire
// mid-run, so every sweep refund must carry a key or two overlapping runs both
// refund. Source-level because the sweeps' unit suites mock the refund door.
import fs from "fs";
import path from "path";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

/** Each `refundBookingPayment({...})` call's argument object, brace-matched. */
function refundCallSites(src: string): string[] {
  const sites: string[] = [];
  const open = /refundBookingPayment\(\{/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(src)) !== null) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (let i = end - 1; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    sites.push(src.slice(match.index, end));
  }
  return sites;
}

describe("every sweep refund carries a dedupeKey", () => {
  it.each([
    "scripts/appointments/expire-stale-requests.ts",
    "scripts/appointments/settle-cancelled-sessions.ts",
  ])("%s", (file) => {
    const sites = refundCallSites(read(file));
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(site).toMatch(/\bdedupeKey\b/);
  });

  // A no-show refund is an owed marker; the marker's key is the dedupeKey.
  it("lib/booking/consultant-no-show.ts", () => {
    const src = read("lib/booking/consultant-no-show.ts");
    expect(refundCallSites(src)).toEqual([]);
    expect(src).toContain("key: `consultant-no-show:${paymentId}`");
    expect(src).toContain(
      "key: `expert-absent:${refund.occurrenceId}:pay:${refund.payment.id}`",
    );
    // One drive, of a marker, and each marker handed to it comes from one of the two keyed builders.
    expect(src.match(/driveRefundOwed\(/g)).toEqual(["driveRefundOwed("]);
    expect(src).toContain("driveRefundOwed(marker)");
    expect(
      src.match(
        /driveNoShowRefund\(\s*(?:noShowRefundOwed|sessionNoShowRefundOwed)\(/g,
      ),
    ).toHaveLength(2);
    expect(src.match(/driveNoShowRefund\(/g)).toHaveLength(3);
  });
});
