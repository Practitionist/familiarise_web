export interface ICollaboratorInfo {
  id: string;
  role: string;
  consultantProfile: {
    id: string;
    user: { id: string; name: string | null; image: string | null };
  };
}
