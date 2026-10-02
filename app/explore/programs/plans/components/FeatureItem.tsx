type FeatureItemProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number | React.ReactNode;
};

export const FeatureItem = ({ icon, label, value }: FeatureItemProps) => (
  <div className="flex min-h-[92px] items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
      {icon}
    </div>
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  </div>
);
