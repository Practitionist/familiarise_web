/**
 * Layout for the two routes under `/dashboard/organization` that are not a
 * specific org: the bare redirect and the legacy create wizard (see
 * create/layout.tsx). The (switcher) group keeps it out of `/[orgId]/*`.
 *
 * #1527 — only the legacy create wizard renders here now, so the old slim
 * top bar went; the frame keeps the viewport contract every shell pins.
 */

export default function OrganizationSwitcherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen-maintenance min-h-0 flex-col overflow-hidden bg-zinc-50">
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
