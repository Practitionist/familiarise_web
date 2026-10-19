import { retiredSupportEndpoint } from "@/lib/api/retired-endpoint";

export function GET() {
  return retiredSupportEndpoint();
}

