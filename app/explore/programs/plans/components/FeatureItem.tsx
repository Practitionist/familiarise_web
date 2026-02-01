type FeatureItemProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number | React.ReactNode;
};

export const FeatureItem = ({ icon, label, value }: FeatureItemProps) => (
  <div className="flex items-center gap-3 p-4 bg-zinc-50 rounded-xl">
    <div className="w-10 h-10 rounded-lg bg-white border border-zinc-200 flex items-center justify-center text-zinc-600">
      {icon}
    </div>
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-zinc-900">{value}</p>
    </div>
  </div>
);
