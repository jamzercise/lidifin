# Troubleshooting: Library Artist Links Show jellyfin:uuid Instead of Artist Name

## Problem
Clicking an artist in the Library navigates to `/artist/jellyfin:f0ad6184cae99631d5e5035cf62f7f7a` instead of `/artist/ArtistName` or `/artist/{mbid}`.

## Root Cause
The link is built by `toArtistRouteId(artist)` which returns:
1. `artist.mbid` if available (MusicBrainz ID)
2. `artist.name` if it's a Jellyfin artist and name is non-empty
3. Otherwise `artist.id` (the jellyfin:uuid)

Getting jellyfin:uuid means the frontend received an artist object with **no usable mbid and no usable name**.

---

## Troubleshooting Plan

### Step 1: Verify Deployment
**Most likely cause: running old code.**

- [ ] Rebuild the Docker image: `docker build -t jamzercise/lidifin:latest .`
- [ ] Redeploy/restart the container with the new image
- [ ] Confirm the image was built after commit `57ce790` or later (artist URL fixes)

To check: Inspect container creation date or run `docker images` and verify the lidifin image timestamp.

### Step 2: Verify API Response
**Confirm the backend returns `name` and optionally `mbid` for each artist.**

**Option A – Browser DevTools:**
1. Open DevTools (F12) → Network tab
2. Go to Library → Artists tab
3. Find the request to `/api/library/artists?limit=40&offset=0&filter=owned&sortBy=name`
4. Inspect the Response → `artists` array
5. For each artist, verify:

**Option B – curl (replace with your app URL and ensure you're logged in or use a session cookie):**
```bash
curl -s "http://10.0.0.248:31013/api/library/artists?limit=5&offset=0&filter=owned&sortBy=name" \
  -H "Cookie: connect.sid=YOUR_SESSION_COOKIE" | jq '.artists[0]'
```
Expected: `{"id":"jellyfin:...","name":"Artist Name",...}` with non-empty `name`.

For each artist in the response, verify:
   - `id`: e.g. `"jellyfin:f0ad6184cae99631d5e5035cf62f7f7a"`
   - `name`: **must be non-empty** (e.g. `"Lucero"`)
   - `mbid`: optional (MusicBrainz ID when Jellyfin has it)

**If `name` is missing or empty** → Backend/Jellyfin issue (see Step 4).  
**If `name` is present** → Frontend or caching issue (see Step 3).

### Step 3: Clear Caches
**Stale data can persist in React Query and the browser.**

- [ ] Hard refresh: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)
- [ ] Clear site data for the app (Application → Storage → Clear site data)
- [ ] Or use an incognito/private window to test

### Step 4: Verify Jellyfin API Response
**Jellyfin might return artists without a Name field.**

1. Call Jellyfin directly (replace with your Jellyfin URL and API key):
   ```
   GET {JELLYFIN_URL}/Users/{USER_ID}/Items?IncludeItemTypes=MusicArtist&Limit=5&Fields=Id,Name,ImageTags,ProviderIds
   ```
2. Check each item in `Items`:
   - `Id`: Jellyfin UUID
   - `Name`: **must be present** (artist name)
   - `ProviderIds`: may contain `MusicbrainzArtist` or `MusicBrainzArtist`

**If Jellyfin returns no `Name`** → Fix metadata in Jellyfin (run library scan, enable MusicBrainz metadata, or fix tags).

### Step 5: Verify Code Path
**Ensure the Library uses the correct API and component.**

- Library page → `useLibraryArtistsQuery` → `api.getArtists` → `GET /api/library/artists`
- For Jellyfin mode, backend uses `getJellyfinArtists()` and returns `{ id, name, mbid, ... }`
- `ArtistsGrid` receives `artists` and renders `Link href={/artist/${toArtistRouteId(artist)}}`

No other code path should serve Library artists.

### Step 6: Add Temporary Debug Logging (Optional)
**To see exactly what the frontend receives:**

In `frontend/features/library/components/ArtistsGrid.tsx`, temporarily add inside the map:

```tsx
{artists.map((artist, index) => {
  if (index === 0) console.log("[DEBUG] First artist:", artist);
  return (
    <ArtistCardItem ... />
  );
})}
```

Check the browser console when loading the Library. Verify `artist.name` and `artist.id` for the first artist.

---

## Fixes Applied (in codebase)

1. **Backend `getJellyfinArtists`**: Always returns non-empty `name` (fallback: "Unknown Artist"); supports both `Name` and `name` from Jellyfin; includes `mbid` from ProviderIds when available.
2. **Backend `GET /library/artists/:id`**: Supports lookup by `jellyfin:uuid` so existing/bookmarked URLs still work.
3. **Frontend `toArtistRouteId`**: Uses `artist.name?.trim()` and prefers mbid → name → id.

---

## Quick Checklist

| Check | Expected |
|-------|----------|
| Docker image rebuilt after fixes | Yes |
| API response has `name` for each artist | Non-empty string |
| React Query / browser cache cleared | Fresh request |
| Jellyfin returns `Name` for artists | Present in Items |
| `toArtistRouteId` receives artist with `name` | Yes |
