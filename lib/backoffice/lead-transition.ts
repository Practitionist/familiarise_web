import { LeadStatus } from "@prisma/client";
import { z } from "zod";

/** The lead transition door's body; `withOpsAction` adds the required reason. */
export const leadTransitionShape = { status: z.nativeEnum(LeadStatus) };
