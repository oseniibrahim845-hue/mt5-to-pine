// HTTP API: POST MQL5 source, get Pine Script v6 back.

import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { KeyStore } from "./keys.js";
import { convert } from "./translator.js";
import { VERSION } from "./version.js";

const MAX_SOURCE_BYTES = 512 * 1024;
const RATE_LIMIT_PER_MINUTE = 60;

export function createApp(store: KeyStore) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_SOURCE_BYTES * 2 }));
  app.use(express.text({ type: ["text/plain", "text/x-mql5"], limit: MAX_SOURCE_BYTES }));

  const hits = new Map<string, number[]>();

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.get("x-api-key") ?? "").trim();
    if (!key || !store.get(key)) {
      res.status(401).json({ error: "missing or invalid API key" });
      return;
    }
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= RATE_LIMIT_PER_MINUTE) {
      res.status(429).json({ error: `rate limit: ${RATE_LIMIT_PER_MINUTE} requests per minute` });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    res.locals.apiKey = key;
    next();
  };

  app.get("/v1/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  app.get("/v1/usage", auth, (_req, res) => {
    const rec = store.get(res.locals.apiKey as string)!;
    res.json({ name: rec.name, credits_remaining: rec.credits, used: rec.used });
  });

  app.post("/v1/convert", auth, (req, res) => {
    const body = req.body as unknown;
    let source: string | undefined;
    let options: { title?: string; alignNewBar?: boolean } = {};
    if (typeof body === "string") {
      source = body;
    } else if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.source === "string") source = b.source;
      if (b.options && typeof b.options === "object") {
        const o = b.options as Record<string, unknown>;
        if (typeof o.title === "string") options.title = o.title.slice(0, 100);
        if (typeof o.alignNewBar === "boolean") options.alignNewBar = o.alignNewBar;
      }
    }
    if (!source || !source.trim()) {
      res.status(400).json({ error: 'send MQL5 code as JSON {"source": "..."} or as text/plain' });
      return;
    }
    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
      res.status(413).json({ error: `source is larger than ${MAX_SOURCE_BYTES / 1024} KB` });
      return;
    }
    const key = res.locals.apiKey as string;
    const rec = store.spend(key);
    if (!rec) {
      res.status(402).json({ error: "no credits left on this key" });
      return;
    }
    const started = Date.now();
    let result;
    try {
      result = convert(source, options);
    } catch (e) {
      store.refund(key);
      res.status(500).json({ error: "internal converter error", detail: (e as Error).message });
      return;
    }
    if (result.status === "failed") store.refund(key);
    res.json({
      status: result.status,
      pine: result.pine,
      issues: result.issues,
      stats: result.stats,
      converter_version: VERSION,
      elapsed_ms: Date.now() - started,
      credits_remaining: store.get(key)!.credits,
    });
  });

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large") {
      res.status(413).json({ error: "request body too large" });
      return;
    }
    if (err.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    res.status(err.status ?? 500).json({ error: "server error" });
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8080);
  const store = new KeyStore(process.env.KEYS_FILE ?? "data/keys.json");
  createApp(store).listen(port, () => {
    console.log(`mt5-to-pine ${VERSION} listening on :${port}`);
  });
}
