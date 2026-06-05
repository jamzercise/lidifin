import { ReactNode } from "react";
import { PageHero } from "@/components/ui/PageHero";
import type { Accent } from "@/components/ui/accent";

interface LibraryHeaderProps {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  icon?: ReactNode;
  accent?: Accent;
  showSync?: boolean;
}

export function LibraryHeader({
  title = "Your Library",
  subtitle,
  eyebrow,
  icon,
  accent = "brand",
}: LibraryHeaderProps) {
  return (
    <PageHero
      variant="compact"
      accent={accent}
      eyebrow={eyebrow}
      icon={icon}
      title={title}
      subtitle={subtitle}
    />
  );
}
