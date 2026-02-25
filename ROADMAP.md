# Lidifin Roadmap

A prioritized todo list for upcoming features. Work through these one at a time when ready.

---

## 1. Improve load time for Artists and Albums

**Status:** Not started

**Scope:**
- Optimize artist page load (backend enrichment, caching, prefetching)
- Optimize album page load
- Identify bottlenecks (API calls, DB queries, frontend rendering)
- Consider: streaming responses, parallel fetches, better cache TTLs, skeleton loaders

---

## 2. Add 'heart' icon to songs to add them to Favorites in Jellyfin

**Status:** Completed

**Scope:**
- Add heart/like icon to track rows (library, artist page, album page, search, etc.)
- Wire to Jellyfin Favorites API (add/remove favorite)
- Persist favorite state and reflect in UI
- May need to check existing Jellyfin integration for favorites (`addJellyfinFavorite`, `removeJellyfinFavorite`)

---

## 3. Pull playlists from Jellyfin and display under Your Playlists section

**Status:** Completed

**Scope:**
- Fetch playlists from Jellyfin API
- Display in "Your Playlists" section (or equivalent)
- Allow editing playlists: add/remove tracks, rename, reorder
- Sync changes back to Jellyfin
- Handle create/delete if Jellyfin supports it

---

## 4. Plan out and implement integration with AudioMuse-AI

**Status:** Completed

**Scope:**
- Research AudioMuse-AI: standalone instance vs Jellyfin plugin vs both
- Recreate "Vibes" system using AudioMuse-AI
- Define integration points (API, plugin hooks, data flow)
- Implement: mood/vibe selection → playlist generation → playback

---

## 5. Create different themes (3–5) for Lidifin

**Status:** Completed

**Scope:**
- Design 3–5 distinct themes (e.g. dark, light, high-contrast, warm, cool)
- Implement theme switching (CSS variables, Tailwind, or theme provider)
- Persist user theme preference
- Ensure all components respect the active theme

---

## Order of work

1. Improve load time for Artists and Albums  
2. Add heart icon for Jellyfin Favorites  
3. Jellyfin playlists in Your Playlists  
4. AudioMuse-AI / Vibes integration  
5. Themes  

---

*Last updated: Feb 2025*
