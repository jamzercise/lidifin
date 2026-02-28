interface LibraryHeaderProps {
  title?: string;
  subtitle?: string;
  showSync?: boolean;
}

export function LibraryHeader({ title = "Your Library", subtitle, showSync }: LibraryHeaderProps) {
  return (
    <div className="relative">
      {/* Quick gradient fade - yellow to purple */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0 bg-gradient-to-b from-[#B1D2C3]/15 via-purple-900/10 to-transparent"
          style={{ height: "35vh" }}
        />
        <div
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#B1D2C3]/8 via-transparent to-transparent"
          style={{ height: "25vh" }}
        />
      </div>

      {/* Compact header */}
      <div className="relative px-4 md:px-8 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-white">
          {title}
        </h1>
        {subtitle != null && subtitle !== "" && (
          <p className="text-sm text-gray-400 mt-0.5">{subtitle}</p>
        )}
      </div>
    </div>
  );
}
