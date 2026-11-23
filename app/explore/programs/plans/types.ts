export interface ICollaboratorInfo {
  id: string;
  role: string;
  consultantProfile: {
    id: string;
    /** Only a VERIFIED profile has a public expert page. */
    verificationStatus: string;
    user: { name: string | null; image: string | null };
  };
}
