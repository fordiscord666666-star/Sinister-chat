# SINISTER Network Chat Server

This is the backend for the SINISTER cross-game chat built into the matching Lua file.

## What it does

- Creates anonymous SINISTER chat sessions.
- Gives each user a random name such as `Cultist-A1B2C3`.
- Sends messages between SINISTER users in completely different Roblox experiences.
- Shows an online-user count.
- Keeps the latest message history.
- Rate-limits message spam.
- Includes a report endpoint for future moderation tools.
- Does **not** require or collect the user's Roblox username by default.

## Run locally

Install Node.js 18+ and run:

```bash
npm install
npm start
```

The server starts at `http://localhost:8787`.

## Put it online

Deploy this folder to any normal Node.js hosting service that gives you an HTTPS URL, such as Render, Railway, Fly.io, or your own VPS.

A `render.yaml` file is included for convenience.

If your host supports persistent disks/volumes, set `DATA_FILE` to a path on that volume so chat history survives server restarts.

## Connect SINISTER

After deployment, copy your public HTTPS server URL.

Open the unprotected `SINISTER_NETWORK_CHAT.lua` and change:

```lua
ThemeSys.chatApiBase =
    ThemeSys.chatApiBase
    or "https://YOUR-SINISTER-CHAT-SERVER.example.com"
```

to your real URL, for example:

```lua
ThemeSys.chatApiBase =
    ThemeSys.chatApiBase
    or "https://sinister-network-chat.onrender.com"
```

Then protect the updated Lua file again before distributing it.

## API

- `POST /v1/session`
- `POST /v1/heartbeat`
- `GET /v1/presence`
- `GET /v1/messages?after=0&limit=60`
- `POST /v1/messages`
- `POST /v1/report`

Sessions use a bearer token returned by `/v1/session`.

## Important security note

The Lua client is untrusted because it runs on the buyer's device. Never place database admin keys, hosting secrets, or moderation credentials inside the Lua script. Keep privileged credentials only on the server.
