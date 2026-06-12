import { ReactNode } from "react";
import { PageHero } from "@/components/ui/PageHero";
import type { Accent } from "@/components/ui/accent";

interface LibraryHeaderProps {
  title?: string;
  subtitle?: ReactNode;
  eyebrow?: string;
  icon?: ReactNode;
  accent?: Accent;
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
      actions={actions}
    />
  );
}
