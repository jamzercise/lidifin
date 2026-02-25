import { ReactNode } from "react";

interface SettingsSectionProps {
    id: string;
    title: string;
    description?: string;
    children: ReactNode;
    showSeparator?: boolean;
}

export function SettingsSection({ 
    id, 
    title, 
    description, 
    children, 
    showSeparator = true 
}: SettingsSectionProps) {
    return (
        <section id={id} className="scroll-mt-24">
            <div className="mb-4">
                <h2 className="text-base font-semibold text-theme-text-primary">{title}</h2>
                {description && (
                    <p className="text-sm text-theme-text-secondary mt-0.5">{description}</p>
                )}
            </div>
            
            <div className="space-y-1">
                {children}
            </div>
            
            {showSeparator && (
                <div className="border-t border-white/5 mt-6 mb-6" />
            )}
        </section>
    );
}

