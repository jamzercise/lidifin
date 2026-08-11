/**
 * Short relative time for activity and history lists, falling back to a plain
 * date once something is more than a day old.
 */
export function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();

    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return date.toLocaleDateString();
}
