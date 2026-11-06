/**
 * The subscription editor tells the author that a terms edit spares the plan's
 * live clients: the loader asks the plan GET for them, and the count becomes
 * the Pricing section's description.
 */
import fs from "node:fs";
import path from "node:path";
import { activeClientsNotice } from "@/lib/booking/entitlement";
import { SUBSCRIPTION_MANIFEST } from "@/components/offerings/editor/manifests";
import {
  activeClientsOf,
  withPricingNotice,
} from "@/components/offerings/editor/sold-terms-notice";

it("reads the author's live-client count off the loaded plan", () => {
  const event = {
    type: "subscription",
    id: "plan-1",
    subscriptionPlan: { id: "plan-1", activeClients: 3 },
  };
  expect(activeClientsOf(event)).toBe(3);
  expect(activeClientsOf({ subscriptionPlan: { id: "plan-1" } })).toBe(0);
});

it("puts the notice on the Pricing section only", () => {
  const notice = activeClientsNotice(3);
  expect(notice).not.toBeNull();
  const manifest = withPricingNotice(SUBSCRIPTION_MANIFEST, notice ?? "");
  const pricing = manifest.sections.find((s) => s.id === "pricing");
  expect(pricing?.description).toBe(
    "3 active clients keep their current terms. Changes apply to new buyers only.",
  );
  const others = manifest.sections.filter((s) => s.id !== "pricing");
  expect(others).toEqual(
    SUBSCRIPTION_MANIFEST.sections.filter((s) => s.id !== "pricing"),
  );
});

it("asks the plan GET for the live-client count when loading a subscription", () => {
  const loader = fs.readFileSync(
    path.join(process.cwd(), "components/offerings/editor/load-offering.ts"),
    "utf8",
  );
  expect(loader).toContain(
    "`/api/plans/subscriptions/${id}?include=activeClients`",
  );
});
