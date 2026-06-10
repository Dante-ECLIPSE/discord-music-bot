# 🎵 Discord Music Bot

A fully-featured Discord music bot supporting **YouTube**, **YouTube Music**, **Spotify**, **SoundCloud**, and plain search — with slash commands and interactive buttons.

---

## ✨ Features

- 🎧 Play from **YouTube**, **YouTube Music**, **Spotify** (tracks, playlists, albums), **SoundCloud**
- 🔍 **Search by name** — just type the song name, no URL needed
- 📋 **Queue management** — add, remove, shuffle, view
- 🔁 **Loop modes** — off, track, queue
- 🔊 **Volume control**
- ⏸️ **Pause / Resume / Skip / Stop**
- 🕹️ **Interactive buttons** on the Now Playing card
- ⚡ **Slash commands** (modern Discord UI)

---

## 🚀 Setup

### Step 1: Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name
3. Go to **Bot** tab → click **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, enable:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `Send Messages`, `Embed Links`, `Read Message History`
6. Copy the generated URL and invite the bot to your server
7. Also copy the **Application ID** (shown on the General Information page)

### Step 2: (Optional) Create a Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Copy the **Client ID** and **Client Secret**

### Step 3: Configure the Bot

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id

# Optional — needed for Spotify links
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
```

---

## 🖥️ Running Locally

### Requirements
- Node.js 18+
- ffmpeg installed (`brew install ffmpeg` / `apt install ffmpeg`)
- yt-dlp installed (`pip install yt-dlp`)

```bash
npm install
node index.js
```

---

## 🐳 Deploy with Docker (Recommended)

Everything (ffmpeg, yt-dlp, Node) is bundled in the container — no manual installs.

```bash
# 1. Build and start
docker compose up -d

# 2. View logs
docker compose logs -f

# 3. Stop
docker compose down
```

---

## ☁️ Deploy to a VPS / Cloud Server

Works on any server running Docker (Ubuntu, Debian, etc.):

```bash
# Install Docker (Ubuntu)
curl -fsSL https://get.docker.com | sh

# Clone this project
git clone <your-repo-url> discord-music-bot
cd discord-music-bot

# Add your .env file
cp .env.example .env
nano .env  # fill in your tokens

# Start the bot
docker compose up -d
```

---

## 🌐 Deploy to EdgeOne / Other PaaS

EdgeOne Pages doesn't support persistent Node.js processes. To run this bot on EdgeOne or similar platforms:

**Option A — Use EdgeOne with an always-on container (recommended)**
- Use EdgeOne's **Container Service** (not Pages) if available
- Deploy the Docker image directly

**Option B — Railway / Render / Fly.io (easiest free options)**

### Deploy to Railway (Free)
1. Go to [railway.app](https://railway.app)
2. Click **New Project → Deploy from GitHub**
3. Connect your repo
4. Add environment variables in the Railway dashboard
5. Done — Railway detects the Dockerfile automatically

### Deploy to Render
1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Select **Docker** environment
4. Add environment variables
5. Deploy!

### Deploy to Fly.io
```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Launch (first time)
fly launch

# Set secrets
fly secrets set DISCORD_TOKEN=xxx CLIENT_ID=xxx

# Deploy
fly deploy
```

---

## 🎮 Commands

| Command | Description |
|---|---|
| `/play <query or URL>` | Play from YouTube, Spotify, SoundCloud, or search |
| `/skip` | Skip current track |
| `/stop` | Stop and clear queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/queue` | View the queue |
| `/nowplaying` | Show current track info |
| `/volume <1-100>` | Set volume |
| `/loop <off/track/queue>` | Set loop mode |
| `/shuffle` | Shuffle the queue |
| `/remove <position>` | Remove a track from queue |
| `/seek <seconds>` | Seek to position in track |
| `/leave` | Disconnect the bot |
| `/help` | Show all commands |

---

## 🔗 Supported Sources

| Source | URLs Supported |
|---|---|
| YouTube | Videos, playlists, shorts, youtube.com, youtu.be |
| YouTube Music | music.youtube.com links |
| Spotify | Tracks, playlists, albums |
| SoundCloud | Individual tracks |
| Search | Any text query |

---

## 🛠️ Troubleshooting

**Bot doesn't respond to slash commands**
- Wait up to 1 hour for global commands to propagate, or invite the bot to a test server and check your CLIENT_ID.

**"No audio" or stream errors**
- Make sure `ffmpeg` and `yt-dlp` are installed (handled automatically in Docker).

**Spotify links not working**
- Add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to your `.env`.

---

## 📄 License

MIT — free to use and modify.
