/**
 * A discovery pass that listed nothing, for the suites of the two reconciler
 * jobs: they run the real job and the pass has its own suite.
 */
import type { DisputeDiscoveryRun } from "../../lib/payments/discovery/dispute-discovery";
import type { RefundDiscoveryRun } from "../../lib/payments/discovery/refund-discovery";

export const quietRefundDiscovery = (): RefundDiscoveryRun => ({
  listed: 0,
  imported: 0,
  alreadyKnown: 0,
  unknownPayment: 0,
  gatewayFailed: 0,
  noRefundRow: 0,
  errors: [],
  stoppedShort: null,
  checkpoint: '{"since":1764244800,"window":null,"cutRuns":0}',
});

export const quietDisputeDiscovery = (): DisputeDiscoveryRun => ({
  listed: 0,
  imported: 0,
  alreadyKnown: 0,
  updated: 0,
  notAdopted: 0,
  unknownPayment: 0,
  waiting: 0,
  untried: 0,
  errors: [],
  stoppedShort: null,
  checkpoint: '{"skip":0,"cutRuns":0,"deferred":[]}',
});

/** The `jest.mock` factory body for the dispute pass in a suite that never looks at it. */
export function quietDisputeDiscoveryModule(): object {
  return { discoverGatewayDisputes: async () => quietDisputeDiscovery() };
}
