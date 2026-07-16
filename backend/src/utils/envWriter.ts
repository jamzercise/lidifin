import fs from "fs";
import { logger } from "./logger";
import path from "path";

/**
 * Parse a stored .env value, undoing the quoting applied by formatEnvValue so
 * values round-trip cleanly (no double-escaping across writes).
 */
function parseEnvValue(raw: string): string {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value
            .slice(1, -1)
            .replace(/\\n/g, "\n")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * Serialize a value for safe inclusion in a .env file.
 *
 * Without this, a value containing a newline could inject arbitrary
 * additional environment variables (e.g. an API key set to
 * "abc\nADMIN=true"), and values with spaces or `#` would be silently
 * truncated. Newlines and carriage returns are stripped outright (they can
 * never be a legitimate part of these single-line values); anything with
 * shell/dotenv-significant characters is double-quoted and escaped.
 */
function formatEnvValue(value: string): string {
    const sanitized = value.replace(/[\r\n]+/g, " ");
    // Safe to write bare: no whitespace and no characters that a dotenv or
    // shell parser would treat specially.
    if (sanitized !== "" && /^[A-Za-z0-9_./:@+-]+$/.test(sanitized)) {
        return sanitized;
    }
    const escaped = sanitized
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
    return `"${escaped}"`;
}

/**
 * Writes key-value pairs to .env file
 * Preserves existing variables not in the provided map
 */
export async function writeEnvFile(
    variables: Record<string, string | null | undefined>
): Promise<void> {
    // Write to project root .env (parent of backend dir) for docker-compose
    const envPath = path.resolve(process.cwd(), "..", ".env");

    // Read existing .env
    let existingContent = "";
    const existingVars = new Map<string, string>();

    try {
        existingContent = fs.readFileSync(envPath, "utf-8");

        // Parse existing variables
        existingContent.split("\n").forEach((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
                const [key, ...valueParts] = trimmed.split("=");
                if (key) {
                    existingVars.set(
                        key.trim(),
                        parseEnvValue(valueParts.join("="))
                    );
                }
            }
        });
    } catch (error) {
        logger.debug("No existing .env file, creating new one");
    }

    // Update with new values
    Object.entries(variables).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            existingVars.set(key, value);
        }
    });

    // Build new .env content
    const lines: string[] = [
        "# Lidifin Environment Variables",
        `# Auto-generated on ${new Date().toISOString()}`,
        "",
    ];

    // Group variables by category
    const categories = {
        "Database & Redis": ["DATABASE_URL", "REDIS_URL"],
        Server: ["PORT", "NODE_ENV", "SESSION_SECRET", "ALLOWED_ORIGINS"],
        Lidarr: ["LIDARR_ENABLED", "LIDARR_URL", "LIDARR_API_KEY"],
        "Last.fm": ["LASTFM_API_KEY", "LASTFM_API_SECRET"],
        "Fanart.tv": ["FANART_API_KEY"],
        OpenAI: ["OPENAI_API_KEY"],
        Audiobookshelf: ["AUDIOBOOKSHELF_URL", "AUDIOBOOKSHELF_API_KEY"],
        Soulseek: ["SLSKD_SOULSEEK_USERNAME", "SLSKD_SOULSEEK_PASSWORD"],
        "VPN (Mullvad)": [
            "MULLVAD_PRIVATE_KEY",
            "MULLVAD_ADDRESSES",
            "MULLVAD_SERVER_CITY",
        ],
        "Docker Paths": ["MUSIC_PATH", "DOWNLOAD_PATH"],
        Security: ["SETTINGS_ENCRYPTION_KEY"],
    };

    const writtenKeys = new Set<string>();

    // Write categorized variables
    Object.entries(categories).forEach(([category, keys]) => {
        const categoryVars: string[] = [];

        keys.forEach((key) => {
            if (existingVars.has(key)) {
                const value = existingVars.get(key) ?? "";
                categoryVars.push(`${key}=${formatEnvValue(value)}`);
                writtenKeys.add(key);
            }
        });

        if (categoryVars.length > 0) {
            lines.push("", `# ${category}`, ...categoryVars);
        }
    });

    // Write uncategorized variables
    const uncategorized: string[] = [];
    existingVars.forEach((value, key) => {
        if (!writtenKeys.has(key)) {
            uncategorized.push(`${key}=${formatEnvValue(value)}`);
        }
    });

    if (uncategorized.length > 0) {
        lines.push("", "# Other Variables", ...uncategorized);
    }

    lines.push(""); // Trailing newline

    // Write to file
    fs.writeFileSync(envPath, lines.join("\n"), "utf-8");
    logger.debug(`.env file updated with ${existingVars.size} variables`);
}
