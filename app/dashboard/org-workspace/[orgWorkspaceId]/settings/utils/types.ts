/**
 * Shared types for the OrgWorkspace settings page.
 *
 * Mirrors the wire shape returned by GET /api/org-workspace/[id]/settings.
 */

interface OrgWorkspaceSettings {
  id: string;
  defaultLandingOrganizationId: string | null;
  locale: string | null;
  currencyDisplayCode: string | null;
  updatedAt: string;
}

export interface CandidateOrg {
  id: string;
  name: string;
  status: string;
}

export interface SettingsGetResponse {
  profile: OrgWorkspaceSettings;
  candidateOrgs: CandidateOrg[];
}

export interface PatchSettingsBody {
  defaultLandingOrganizationId?: string | null;
  locale?: string | null;
  currencyDisplayCode?: string | null;
}
