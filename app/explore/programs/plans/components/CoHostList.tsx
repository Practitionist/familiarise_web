import Image from "next/image";
import Link from "next/link";
import { Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRole } from "@/components/collaborators/format";
import type { ICollaboratorInfo } from "../types";

type CoHostListProps = {
  title: string;
  /** Image alt text for a co-host with no name. */
  unnamed: string;
  collaborators: ICollaboratorInfo[] | undefined;
  className?: string;
};

/**
 * A plan's accepted co-hosts: name, face and role. The name links to the
 * expert page only when that page is public, which is a verified profile.
 */
export function CoHostList({
  title,
  unnamed,
  collaborators,
  className,
}: CoHostListProps) {
  if (!collaborators || collaborators.length === 0) return null;
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="w-4 h-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {collaborators.map((collab) => {
          const profile = collab.consultantProfile;
          const person = (
            <>
              <div className="relative h-10 w-10 rounded-full overflow-hidden ring-2 ring-border flex-shrink-0">
                <Image
                  src={profile.user.image ?? "/placeholder-user.jpg"}
                  alt={profile.user.name ?? unnamed}
                  fill
                  className="object-cover"
                />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {profile.user.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatRole(collab.role)}
                </p>
              </div>
            </>
          );
          return profile.verificationStatus === "VERIFIED" ? (
            <Link
              key={collab.id}
              href={`/explore/experts/${profile.id}`}
              className="flex items-center gap-3 hover:bg-muted rounded-lg p-2 -mx-2 transition-colors"
            >
              {person}
            </Link>
          ) : (
            <div key={collab.id} className="flex items-center gap-3 p-2 -mx-2">
              {person}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
