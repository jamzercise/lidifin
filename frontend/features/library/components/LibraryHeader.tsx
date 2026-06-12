import { ReactNode } from "react";
import { PageHero, PageHeroStat } from "@/components/ui/PageHero";
import type { Accent } from "@/components/ui/accent";

interface LibraryHeaderProps {
  title?: string;
  subtitle?: ReactNode;
  eyebrow?: string;
  icon?: ReactNode;
  accent?: Accent;
  /** Stat chips beneath the title (counts, durations, etc.). */
  stats?: PageHeroStat[];
  /** Cover art blurred into the header backdrop. */
  backdropImages?: Array<string | null | undefined>;
  /** Right-aligned controls (rendered in PageHero's standard actions slot). */
  actions?: ReactNode;
  showSync?: boolean;
}

export function LibraryHeader({
  title = "Your Library",
  subtitle,
  eyebrow,
  icon,
  accent = "brand",
  stats,
  backdropImages,
  actions,
}: LibraryHeaderProps) {
  return (
    <PageHero
      variant="compact"
      accent={accent}
      eyebrow={eyebrow}
      icon={icon}
      title={title}
      subtitle={subtitle}
      stats={stats}
      backdropImages={backdropImages}
      actions={actions}
    />
  );
}
