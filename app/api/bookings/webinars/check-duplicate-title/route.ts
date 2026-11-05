import type { NextRequest } from "next/server";

import { checkDuplicateTitle } from "@/lib/api/plans/check-duplicate-title";

export function GET(req: NextRequest) {
  return checkDuplicateTitle(req, "webinar");
}
