import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** An operator viewing someone's dashboard sees this instead of their own self-only settings. */
export function OwnerOnlySettingsNote({
  title,
  owner,
}: Readonly<{ title: string; owner: "learner" | "expert" }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Only the {owner} can see and change these settings.
      </CardContent>
    </Card>
  );
}
