import { PLATFORM_DATA_FIDUCIARY } from "./dpdp";
import {
  PURPOSE_CODES,
  purposeCodeAliases,
  TERMS_VERSION,
} from "./purpose-codes";

export function marketingConsentWhere(now = new Date()) {
  return {
    dataFiduciary: PLATFORM_DATA_FIDUCIARY,
    purposeCodes: {
      hasSome: purposeCodeAliases(PURPOSE_CODES.MARKETING_COMMS),
    },
    version: TERMS_VERSION,
    withdrawnAt: null,
    auditRetainedUntil: { gt: now },
  } as const;
}
