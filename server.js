// Claude for Meta Ray-Ban Display — tiny server that serves the glasses web app,
// proxies chat to the Claude API (the API key never leaves the server), and hosts
// the mini web apps Claude writes for the glasses.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createAppStore, MAX_APP_BYTES } from "./apps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const EFFORT = process.env.CLAUDE_EFFORT || "medium";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const APPS_DIR = path.resolve(here, process.env.APPS_DIR || "data/apps");

const BASE_PROMPT = `You are Claude, answering on the heads-up display of Meta Ray-Ban Display smart glasses.
The screen is a small 600x600 square and the wearer is often walking or doing something else.
- Lead with the answer. Keep replies short: usually 1-4 sentences, under 80 words unless asked for more.
- Plain text only. No markdown headings, tables, code fences or bold markers. Short "- " bullet lists are fine.
- The wearer may speak or handwrite their message, so tolerate typos and transcription errors.`;

const APP_BUILDER_PROMPT = `
You can also write mini web apps that run on these glasses, using the list_apps, read_app, save_app and delete_app tools.
When the wearer asks you to make, build or create an app, tool, game, widget or screen, write it and save it with save_app. When they ask to change an app ("make it bigger", "add a reset button"), call read_app first, then save_app with the same app_id and the full updated HTML. If it is unclear which app they mean, call list_apps. Never paste code into your reply: after saving, reply with one short sentence saying what you built or changed.

Rules for every app you write (Meta Ray-Ban Display web app platform):
- One complete, self-contained HTML document with inline <style> and <script>. Scripts from https://cdn.jsdelivr.net or https://cdnjs.cloudflare.com are allowed but rarely needed.
- Include <meta name="viewport" content="width=600, height=600, initial-scale=1.0, user-scalable=no"> and <meta name="mrbd-web-app-capable" content="yes">.
- Fixed 600x600 layout: html, body { width:600px; height:600px; margin:0; overflow:hidden; }. Nothing may need page scrolling; paginate or scroll inner elements with the arrow keys instead.
- Additive see-through display: pure black (#000) is transparent. Use a black background, bright high-contrast text and accents, text at least 24px, no large bright filled areas.
- Input is only keyboard events: ArrowUp/ArrowDown/ArrowLeft/ArrowRight (swipes) and Enter (pinch). There is no mouse, touch or physical keyboard. Every control must be focusable (button or tabindex="0"), at least 88px tall, with a bright visible :focus style. Implement arrow-key focus movement yourself and focus a sensible control on load.
- Escape is reserved: it returns the wearer to Claude. Do not handle or preventDefault Escape.
- Text entry: a focused <input type="text"> or <textarea> opens the glasses' voice/handwriting composer when pinched; read the value from input/change events.
- Available: localStorage (persist app state there, with keys prefixed by the app name), speechSynthesis (one English voice), DeviceOrientationEvent/DeviceMotionEvent (need a user gesture to request permission), navigator.geolocation (from the phone), fetch to https APIs that allow CORS. Not available: camera, microphone, notifications.`;

const SYSTEM_PROMPT = (process.env.SYSTEM_PROMPT || BASE_PROMPT) + "\n" + APP_BUILDER_PROMPT;

const MAX_MESSAGES = 40;
const MAX_CHARS = 20000;
const MAX_TOOL_ROUNDS = 8;

const client = new Anthropic();
const apps = createAppStore({ dir: APPS_DIR });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// --- Tools Claude uses to manage glasses apps --------------------------------

const TOOLS = [
  {
    name: "list_apps",
    description: "List the mini web apps saved for the wearer's glasses (id, title, description, last updated).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_app",
    description: "Read the full HTML source of a saved app. Always call this before modifying an app.",
    input_schema: {
      type: "object",
      properties: { app_id: { type: "string", description: "Id from list_apps or an earlier save_app" } },
      required: ["app_id"],
      additionalProperties: false,
    },
  },
  {
    name: "save_app",
    description:
      "Create a new glasses app, or replace an existing one when app_id is given. html must be the complete, self-contained HTML document. Returns the app's id.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "Omit to create a new app; pass an existing id to overwrite it" },
        title: { type: "string", description: "Short name shown in the app list, e.g. 'Pomodoro Timer'" },
        description: { type: "string", description: "One short sentence describing the app" },
        html: { type: "string", description: "Complete HTML document for the app" },
      },
      required: ["title", "description", "html"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_app",
    description: "Permanently delete a saved app. Only use when the wearer clearly asks to delete it.",
    input_schema: {
      type: "object",
      properties: { app_id: { type: "string" } },
      required: ["app_id"],
      additionalProperties: false,
    },
  },
];

const isStr = (v) => typeof v === "string" && v.trim() !== "";

function validateToolInput(name, input) {
  if (!input || typeof input !== "object") return "Input must be an object.";
  switch (name) {
    case "list_apps":
      return null;
    case "read_app":
    case "delete_app":
      return isStr(input.app_id) ? null : "app_id must be a non-empty string.";
    case "save_app":
      if (input.app_id !== undefined && !isStr(input.app_id)) return "app_id must be a non-empty string when given.";
      if (!isStr(input.title) || !isStr(input.description)) return "title and description are required strings.";
      if (!isStr(input.html) || !/<\/html>\s*$/i.test(input.html)) {
        return "html must be a complete HTML document ending in </html> (it may have been cut off).";
      }
      if (Buffer.byteLength(input.html) > MAX_APP_BYTES) return `html is larger than ${MAX_APP_BYTES} bytes.`;
      return null;
    default:
      return `Unknown tool ${name}.`;
  }
}

// Runs one tool call. Returns { content, isError, app? } where app is set when an app was saved.
async function runTool(block) {
  const problem = validateToolInput(block.name, block.input);
  if (problem) {
    return { isError: true, content: JSON.stringify({ INVALID_INPUT: problem }) };
  }
  const input = block.input;
  try {
    switch (block.name) {
      case "list_apps": {
        const list = await apps.list();
        return { content: list.length ? JSON.stringify(list) : "No apps saved yet." };
      }
      case "read_app":
        return { content: await apps.readHtml(input.app_id) };
      case "save_app": {
        const entry = await apps.save({
          id: input.app_id,
          title: input.title.trim().slice(0, 60),
          description: input.description.trim().slice(0, 200),
          html: input.html,
        });
        return { content: JSON.stringify({ saved: true, app_id: entry.id }), app: entry };
      }
      case "delete_app":
        await apps.remove(input.app_id);
        return { content: JSON.stringify({ deleted: true }), deleted: input.app_id };
    }
  } catch (err) {
    return { isError: true, content: String(err.message || err) };
  }
}

// --- HTTP helpers ------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const authorized = (req) => !ACCESS_TOKEN || req.headers["x-access-token"] === ACCESS_TOKEN;

// Keep only well-formed, alternating text turns that start with the user.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const messages = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages.at(-1).role !== "user") return null;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) return null;
  }
  return messages;
}

// --- Chat --------------------------------------------------------------------

// Streams newline-delimited JSON events to the glasses:
//   {type:"text",text}            answer text
//   {type:"status",text}          progress, e.g. "Writing Timer…"
//   {type:"round"}                a new model request starts (marks where a retry rewinds to)
//   {type:"retry"}                discard text since the last round (request re-issued)
//   {type:"app",app}              an app was saved; {type:"app_deleted",id}
//   {type:"ping"}                 keep-alive, ignored by the client
//   {type:"done"} | {type:"error",error}
async function handleChat(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { error: "Wrong or missing access key" });

  let messages;
  try {
    messages = sanitizeMessages(JSON.parse(await readBody(req)).messages);
  } catch {
    return sendJson(res, 400, { error: "Invalid request" });
  }
  if (!messages) return sendJson(res, 400, { error: "Invalid conversation" });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  const emit = (event) => {
    if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
  };

  let current = null;
  // Keep the connection alive while Claude thinks silently (proxies may drop idle streams).
  const heartbeat = setInterval(() => emit({ type: "ping" }), 10000);
  res.on("close", () => {
    clearInterval(heartbeat);
    current?.abort();
  });

  try {
    let parseRetries = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      emit({ type: "round" });
      current =client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        tools: TOOLS,
        // If a safety classifier declines, retry server-side on Anthropic's recommended model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages,
      });

      let final;
      try {
        let toolBytes = 0;
        let lastReport = 0;
        for await (const event of current) {
          if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            const name = event.content_block.name;
            toolBytes = 0;
            emit({ type: "status", text: name === "save_app" ? "Writing code…" : name === "read_app" ? "Reading app…" : "Working…" });
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") emit({ type: "text", text: event.delta.text });
            else if (event.delta.type === "input_json_delta") {
              toolBytes += event.delta.partial_json.length;
              if (toolBytes - lastReport > 1024) {
                lastReport = toolBytes;
                emit({ type: "status", text: `Writing code… ${(toolBytes / 1024).toFixed(0)} KB` });
              }
            }
          }
        }
        final = await current.finalMessage();
      } catch (err) {
        // With eager input streaming the SDK can fail to parse a tool input it
        // cannot repair. Re-issue the same request a couple of times; rethrow API errors.
        if (err instanceof Anthropic.APIError || res.destroyed || parseRetries >= 2) throw err;
        parseRetries++;
        console.warn("Re-issuing request after stream parse error:", err.message);
        emit({ type: "retry" });
        round--;
        continue;
      }

      if (final.stop_reason === "refusal") {
        emit({ type: "error", error: "Claude declined to answer that one." });
        return res.end();
      }

      const toolUses = final.content.filter((b) => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || !toolUses.length) {
        emit({ type: "done", truncated: final.stop_reason === "max_tokens" });
        return res.end();
      }

      // Run every tool call from this turn and return all results in one user message.
      const results = [];
      for (const block of toolUses) {
        const result = await runTool(block);
        if (result.app) emit({ type: "app", app: result.app });
        if (result.deleted) emit({ type: "app_deleted", id: result.deleted });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages = [...messages, { role: "assistant", content: final.content }, { role: "user", content: results }];
      emit({ type: "status", text: "Finishing…" });
    }
    emit({ type: "error", error: "That took too many steps. Try a simpler request." });
  } catch (err) {
    if (res.destroyed) return;
    let message = "Something went wrong. Try again.";
    if (err instanceof Anthropic.AuthenticationError) message = "Server API key is invalid.";
    else if (err instanceof Anthropic.RateLimitError) message = "Rate limited. Wait a moment.";
    else if (err instanceof Anthropic.APIConnectionError) message = "Can't reach Claude right now.";
    console.error("Claude API error:", err);
    emit({ type: "error", error: message });
  }
  res.end();
}

// --- Apps --------------------------------------------------------------------

// Added to every app page: Escape (the glasses' back gesture) returns to Claude.
const BACK_SCRIPT = `<script>addEventListener("keydown",function(e){if(e.key==="Escape"){e.preventDefault();location.href="/?view=apps";}});</script>`;

async function serveApp(res, id) {
  try {
    if (!(await apps.get(id))) throw new Error("missing");
    const html = await apps.readHtml(id);
    const withBack = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, BACK_SCRIPT + "</body>") : html + BACK_SCRIPT;
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
    res.end(withBack);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("App not found");
  }
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, model: MODEL, locked: Boolean(ACCESS_TOKEN) });
  }
  if (!authorized(req)) return sendJson(res, 401, { error: "Wrong or missing access key" });
  if (req.method === "GET" && url.pathname === "/api/apps") return sendJson(res, 200, { apps: await apps.list() });
  const m = url.pathname.match(/^\/api\/apps\/([a-z0-9-]{1,64})$/);
  if (m && req.method === "DELETE") {
    try {
      await apps.remove(m[1]);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }
  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const app = url.pathname.match(/^\/apps\/([a-z0-9-]{1,64})\/?$/);
    if (app && req.method === "GET") return await serveApp(res, app[1]);
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, url);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude for Meta Ray-Ban Display on http://${HOST}:${PORT} (model: ${MODEL})`);
  console.log(`Apps are stored in ${apps.location}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set — chat requests will fail.");
  }
  if (!ACCESS_TOKEN) {
    console.warn("Warning: ACCESS_TOKEN is not set — anyone with the URL can use your API key.");
  }
});
