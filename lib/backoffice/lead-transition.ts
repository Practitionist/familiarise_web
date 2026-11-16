import { LeadStatus } from "@prisma/client";
import { z } from "zod";

/**
 * The lead transition door's body: the status the operator saw (`from`) and
 * the one they chose; `withOpsAction` adds the required reason.
 */
export const leadTransitionShape = {
  from: z.nativeEnum(LeadStatus),
  status: z.nativeEnum(LeadStatus),
};
