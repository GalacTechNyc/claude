# Claude for Meta Ray-Ban Display

A web app that puts Claude on your **Meta Ray-Ban Display** glasses. Pinch to speak or write a question, and the answer streams onto the 600×600 in-lens display. It can also read answers aloud.

Claude can also **write new apps for your glasses**. Say *"make me a pomodoro timer"* and Claude writes the code, saves it and shows an **▶ Open** button. Then say *"make the numbers bigger"* and Claude reads its own code and updates the app.

- **Pinch the "Ask Claude…" box** to open the glasses' voice and handwriting composer. Your message is sent as soon as you finish.
- **Swipe ↑ / ↓** to page through long answers.
- **Swipe ← / →** to move between the ask box, 🔈 read-aloud, ▦ your apps and ＋ new chat.
- **Back gesture** while Claude is answering stops the reply.

### Apps Claude builds

- Ask for anything that fits a 600×600 swipe-and-pinch screen: timers, counters, checklists, flashcards, a compass, games, a dashboard that pulls from a public API.
- Ask for changes in plain words (*"add a reset button"*, *"make it green"*). Claude edits the app it just built, or the one you name.
- **▦ Your apps** lists everything Claude has built. Pinch one to open it. Swipe → then pinch twice on ✕ to delete it.
- Inside an app, the **back gesture** returns you to your app list.

**What Claude can't change:** Meta only lets outside code run as web apps, so Claude can't touch the glasses' system software, settings, firmware or Meta's built-in apps. Claude's apps can use the display, swipes and pinches, the voice/handwriting composer, text-to-speech, motion sensors, your phone's location, local storage and the internet. The camera and microphone aren't open to web apps yet.

Claude knows it's on a small heads-up display, so it keeps replies short and in plain text. Your conversation is kept on the glasses between sessions until you tap ＋.

## How it works

```
Glasses (web app)  ──HTTPS──▶  server.js  ──▶  Claude API
 public/*                       holds your API key
 /apps/<id>/  ◀──────────────   Vercel Blob or data/apps/  (apps Claude wrote)
```

The glasses load a normal web page. `server.js` serves that page and forwards chat requests to Claude, so your API key never reaches the glasses. Claude has four tools on the server: `list_apps`, `read_app`, `save_app` and `delete_app`. Each app it writes is one HTML file, saved to Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set and to `APPS_DIR` otherwise. It's served at `/apps/<id>/`.

## 1. Deploy it on Vercel (the glasses need HTTPS)

Meta's glasses only load `https://` web apps. Vercel gives you that for free, and it runs `server.js` as-is with no config file.

1. **Import the repo.** Go to https://vercel.com/new and import `GalacTechNyc/claude`. Leave the framework preset as **Other** and the build settings empty.
2. **Add environment variables** before you deploy:
   - `ANTHROPIC_API_KEY`: your Claude API key (https://platform.claude.com/settings/keys)
   - `ACCESS_TOKEN`: any long random passcode you make up. The glasses send it with every request.
3. **Deploy.**
4. **Connect storage for the apps Claude builds.** In the project, open **Storage → Create → Blob**. Choose **Private** access and connect it to the project. Vercel adds `BLOB_READ_WRITE_TOKEN` for you.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the app picks up the storage token.

Your app URL is the project's production domain, e.g. `https://claude-yourname.vercel.app` (Vercel picks the exact name).

> **Use the production URL, not a preview URL.** Vercel protects preview deployments with a login page by default, and the glasses can't get past it. Production deploys come from `main`. If the glasses still see a login screen, check **Settings → Deployment Protection**.

Each request can run for up to 5 minutes, which is Vercel's default on every plan. That's enough for Claude to write an app.

**Other hosts:** anything that runs Node 22+ behind HTTPS works (Railway, Fly.io, Render, a VPS). Run `npm ci && npm start` . Without Blob storage, apps are saved to `APPS_DIR` on disk, so use a persistent disk there.

## 2. Add it to your glasses

1. In the **Meta AI** app, turn on Developer Mode: **Settings → App Info**, then tap **App version** 5 times.
2. Go to **Settings → App Connections → Web Apps → Add a Web App**.
3. Name it `Claude` and use this URL, with your access token on the end:
   ```
   https://YOUR-APP-URL/?key=YOUR_ACCESS_TOKEN
   ```
4. Open **Claude** from the app launcher on your glasses.

You need glasses firmware v125+ and Meta AI app v272+. The key is saved on the glasses after the first launch.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Your Claude API key. |
| `ACCESS_TOKEN` | *(none)* | Passcode the glasses must send. **Set this.** Without it, anyone who finds your URL can spend your API credits. |
| `CLAUDE_MODEL` | `claude-opus-5` | The Claude model to use. |
| `CLAUDE_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max`. Lower is faster and cheaper; higher writes better apps. |
| `BLOB_READ_WRITE_TOKEN` | *(none)* | Set automatically when you connect a Vercel Blob store. Apps are then saved there. |
| `BLOB_ACCESS` | `private` | Match your Blob store's access type (`private` or `public`). |
| `APPS_DIR` | `data/apps` | Where apps are saved when there's no Blob store (local or other hosts). |
| `SYSTEM_PROMPT` | glasses-tuned | Replaces the chat instructions. The app-building rules are always added. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens locally. Vercel ignores these. |

If Claude's safety filter declines a request, the server automatically retries it on Anthropic's recommended fallback model (`fallbacks: "default"`).

## Run locally / test without glasses

```bash
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm install
npm start              # http://localhost:3000
```

Open it in Chrome with the [Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/meta-ray-ban-display-simu/jpjlmmodokemlepklkdbimceggpbjcll) extension. It previews the 600×600 display and lets you test D-pad input. In a plain browser, use the arrow keys, type in the box and press Enter.

To try it on the real glasses before deploying, give your local server an HTTPS address with a tunnel such as `cloudflared tunnel --url http://localhost:3000`.
