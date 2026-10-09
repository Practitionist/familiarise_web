/**
 * Collaborator types shared across services
 */

export interface RevenueSplit {
  consultantProfileId: string | null;
  organizationId?: string | null;
  share: number;
  role: string;
}
