# Lidify: Installation guide (Docker & Dockge)

Step-by-step instructions to run Lidify with Docker or [Dockge](https://github.com/louislam/dockge).

---

## Prerequisites

- **Docker** (20.10+)
- **Docker Compose** (v2) if you use a compose file
- **Dockge** (optional) – only if you want the Dockge web UI to manage the stack
- A **music library path** on the host (or plan to use [Jellyfin as music source](https://github.com/jamzercise/lidifin#jellyfin-lidifin) so a local path is optional)

---

## Option 1: One-command Docker run

Fastest way to try Lidify. Replace `/path/to/your/music` with your music folder.

```bash
docker run -d \
  --name lidifin-player \
  -p 31013:3030 \
  -v /path/to/your/music:/music \
  -v lidifin_data:/data \
  --add-host=host.docker.internal:host-gateway \
  jamzercise/lidifin:latest
```

- **URL:** http://localhost:31013 (or http://YOUR_SERVER_IP:31013)
- **First run:** Create your account on first open; you become the admin.
- **Data:** Database, cache, and secrets are stored in the named volume `lidifin_data`.

**Optional env vars** (add with `-e VAR=value` before the image name):

| Variable | Description |
|----------|-------------|
| `SESSION_SECRET` | Session encryption (recommended: `openssl rand -base64 32`) |
| `TZ` | Timezone (e.g. `America/New_York`) |
| `JELLYFIN_API_KEY` | Optional: override the API key when using [Lidifin](https://github.com/jamzercise/lidifin#jellyfin-lidifin). The **Jellyfin URL** is set in the app (see below). |
| `LIDIFY_CALLBACK_URL` | URL Lidarr uses for webhooks (e.g. `http://host.docker.internal:31013`) |

Example with secrets and timezone:

```bash
docker run -d \
  --name lidifin-player \
  -p 31013:3030 \
  -v /path/to/your/music:/music \
  -v lidifin_data:/data \
  -e SESSION_SECRET=$(openssl rand -base64 32) \
  -e TZ=America/New_York \
  --add-host=host.docker.internal:host-gateway \
  jamzercise/lidifin:latest
```

---

## Option 2: Docker Compose

Use a compose file for easier env and volume management.

### Step 1: Choose a compose file

- **All-in-one (recommended):** `docker-compose.prod.yml` – single Lidify container (PostgreSQL, Redis, and app inside).
- **Full stack:** `docker-compose.server.yml` – Lidify plus Lidarr, Prowlarr, etc. (see repo for full list).

### Step 2: Create a project directory and `.env`

```bash
mkdir -p ~/lidifin && cd ~/lidifin
```

Create a `.env` file with at least:

```env
# Required: path to your music library on the host
MUSIC_PATH=/path/to/your/music

# Strongly recommended (generate with: openssl rand -base64 32)
SESSION_SECRET=your-generated-session-secret

# Optional but recommended for production
INTERNAL_API_SECRET=your-generated-internal-secret

# Optional
PORT=31013
TZ=America/New_York

# Optional: when using Jellyfin as music source (Lidifin)
# JELLYFIN_API_KEY=your-jellyfin-api-key

# Optional: if Lidarr needs to send webhooks to Lidify
# LIDIFY_CALLBACK_URL=http://host.docker.internal:31013
```

Generate secrets:

```bash
openssl rand -base64 32   # use for SESSION_SECRET
openssl rand -hex 32      # use for INTERNAL_API_SECRET
```

### Step 3: Copy the compose file and start

**All-in-one:**

```bash
# From the Lidify repo root
cp docker-compose.prod.yml docker-compose.yml
docker compose up -d
```

**Full stack (Lidify + Lidarr, etc.):**

```bash
cp docker-compose.server.yml docker-compose.yml
docker compose up -d
```

### Step 4: Open Lidify

Open **http://localhost:31013** (or http://YOUR_SERVER_IP:31013) and create your account.

### Updating

```bash
docker compose pull
docker compose up -d
```

---

## Option 3: Dockge (web UI for Docker Compose)

[Dockge](https://github.com/louislam/dockge) lets you manage Compose stacks from a web interface. Use it if you already run Dockge or want a UI to start/stop and edit the stack.

### Step 1: Install Dockge (if needed)

See [Dockge’s documentation](https://github.com/louislam/dockge#-quick-start). You need Docker and a running Dockge instance.

### Step 2: Create a stack directory

On the host where Dockge runs (e.g. Linux):

```bash
sudo mkdir -p /opt/stacks/lidifin
cd /opt/stacks/lidifin
```

(Use any path your Dockge is configured to use for stacks.)

### Step 3: Add the Compose file

**Option A – Use the repo’s production compose:**

```bash
# If you have the repo cloned
cp /path/to/lidifin/docker-compose.prod.yml compose.yaml
```

**Option B – Use the same compose file (image only or build from Git):**

Use `docker-compose.prod.yml` from the repo root (same as Option A): copy it to `compose.yaml` in your stack directory. Then:

- **Image only:** ensure `image: jamzercise/lidifin:latest` is set (the default in the file).
- **Build from Git:** add a `build` block pointing at the repo; first deploy will take 15–30 minutes (downloads and builds the app).

Edit the **volumes** in `compose.yaml` to match your host paths:

- **Music:** first volume (e.g. `/mnt/Data/MediaServer/Music:/music`) → your music library path.
- **Data:** second volume (e.g. `/mnt/AI/AppData/config/lidifin-2:/data`) → a persistent directory for PostgreSQL, Redis, and cache.

### Step 4: Create `.env` in the stack directory

In the same directory as `compose.yaml` (e.g. `/opt/stacks/lidifin`), create `.env`:

```env
# Required for docker-compose.prod.yml; optional if you use fixed paths in compose
MUSIC_PATH=/path/to/your/music

# Strongly recommended
SESSION_SECRET=your-generated-session-secret
INTERNAL_API_SECRET=your-generated-internal-secret

# Optional
TZ=America/Los_Angeles
PORT=31013
# JELLYFIN_API_KEY=your-jellyfin-api-key
# LIDIFY_CALLBACK_URL=http://host.docker.internal:31013
```

For the Dockge-style compose, if you use bind mounts with fixed paths in `compose.yaml`, you don’t need `MUSIC_PATH` in `.env`; the compose file already has the paths.

### Step 5: Pre-install checklist (bind-mounted `/data`)

If your compose uses a **bind mount** for `/data` (e.g. `/mnt/AI/AppData/config/lidifin-2:/data`):

1. Create the directory and set permissions so the container can write:

   ```bash
   sudo mkdir -p /mnt/AI/AppData/config/lidifin-2
   sudo chmod 755 /mnt/AI/AppData/config/lidifin-2
   ```

2. Ensure the **music path** exists and is readable (e.g. `ls /mnt/Data/MediaServer/Music`).

The steps above are the main pre-install checklist; paths may differ on your system.

### Step 6: Create and deploy the stack in Dockge

1. In the Dockge UI, create a new **Interactive Stack**.
2. Set the **stack path** to your stack directory (e.g. `/opt/stacks/lidifin`). Dockge will use `compose.yaml` and `.env` from that path.
3. Click **Deploy**.
4. Wait for the container to start (or for the first build to finish if you use “build from Git”).

### Step 7: Open Lidify and create account

Open **http://YOUR_SERVER_IP:31013** (or the port you set). Create the first user; this account will be the admin.

---

## After installation

- **First account** – The first user you create is the admin. Use **Settings** to configure music path (if not using Jellyfin), Lidarr, Jellyfin (Lidifin), Soulseek, etc.
- **Lidifin (Jellyfin as music source)** – In **Settings → Jellyfin (Music)** (or during onboarding), enter your Jellyfin URL and API key, then enable “Use Jellyfin for music.” You can set `JELLYFIN_API_KEY` in your `.env` or Docker env to override the value stored in Settings.
- **Lidarr webhooks** – If you use Lidarr, set `LIDIFY_CALLBACK_URL` so Lidarr can reach Lidify (e.g. `http://host.docker.internal:31013` or `http://YOUR_SERVER_IP:31013`). The `extra_hosts: host.docker.internal:host-gateway` in the compose file is required on Linux for `host.docker.internal` to work.

**Where to put your Jellyfin URL** – The Jellyfin **instance URL** is not in `.env` or Docker. Set it in the app: open **Settings → Jellyfin (Music)** (or the Jellyfin step during onboarding), enter your **Jellyfin server URL** (e.g. `http://localhost:8096`, `http://jellyfin.example.com`, or `http://192.168.1.10:8096`), then your API key. Use a URL that the Lidifin container can reach (from inside Docker, `localhost` is the container; use your host IP or hostname if Jellyfin is on the host or another machine). Enable **Use Jellyfin for music** and use **Test connection** to verify. You can optionally set `JELLYFIN_API_KEY` in `.env` to override only the API key.

---

## Troubleshooting

- **Library (artists/albums) not loading when using Jellyfin** – The pre-built image `jamzercise/lidifin:latest` may not include the latest fixes. **Build from source** to get them:
  ```bash
  docker compose -f docker-compose.build.yml up -d --build
  ```
  Or with Dockge: use `docker-compose.build.yml` and enable **Build** before deploy. Set `LOG_LEVEL=info` to see Library logs; if you see `config null`, check Settings → Jellyfin (Music).
- **Container exits or won’t start** – Check logs (`docker compose logs` or Dockge logs). Common causes: permission errors on the `/data` or music volume; fix with `chmod`/`chown` on the host paths.
- **Can’t reach Lidify** – Ensure the host port (e.g. 31013) is not in use and not blocked by a firewall.
- **Lidarr webhooks fail** – Ensure `LIDIFY_CALLBACK_URL` matches the URL Lidarr uses to reach your host (same IP/hostname and port). On Linux, keep `extra_hosts: host.docker.internal:host-gateway` in the compose file when using `host.docker.internal` in the callback URL.
- **Build from Git fails in Dockge** – First build is large and can take 15–30+ minutes. Ensure enough disk space and RAM; if it OOMs, add swap or build on a machine with more memory.

For more configuration options and env vars, see the main [README](README.md) and [Configuration](README.md#configuration) section.
