import type { MemberRole } from "@prisma/client";

export const ORG_ROLE_RANK: Record<MemberRole, number> = {
  OWNER: 100,
  MAINTAINER: 80,
  MANAGER: 60,
  EXPERT: 40,
  SUPPORT: 30,
  LEARNER: 20,
};

export function isAtLeastRole(actual: MemberRole, minimum: MemberRole): boolean {
  return ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[minimum];
}
