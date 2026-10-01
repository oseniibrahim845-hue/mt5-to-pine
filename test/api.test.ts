import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
import { KeyStore } from "../src/keys.js";

const EA = `#include <Trade\\Trade.mqh>
CTrade trade;
void OnTick() { if(iClose(_Symbol, PERIOD_CURRENT, 1) > iOpen(_Symbol, PERIOD_CURRENT, 1)) trade.Buy(0.1); }`;

describe("API", () => {
  let store: KeyStore;
  let key: string;
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    store = new KeyStore(join(mkdtempSync(join(tmpdir(), "m2p-")), "keys.json"));
    key = store.create("tester", 2);
    app = createApp(store);
  });

  it("health works without a key", async () => {
    const r = await request(app).get("/v1/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
  it("rejects missing keys", async () => {
    const r = await request(app).post("/v1/convert").send({ source: EA });
    expect(r.status).toBe(401);
  });
  it("converts JSON and text bodies and counts credits", async () => {
    const a = await request(app).post("/v1/convert").set("Authorization", `Bearer ${key}`).send({ source: EA });
    expect(a.status).toBe(200);
    expect(a.body.status).toBe("full");
    expect(a.body.pine).toContain("//@version=6");
    expect(a.body.credits_remaining).toBe(1);
    const b = await request(app).post("/v1/convert").set("X-API-Key", key).set("Content-Type", "text/plain").send(EA);
    expect(b.status).toBe(200);
    expect(b.body.credits_remaining).toBe(0);
    const c = await request(app).post("/v1/convert").set("X-API-Key", key).send({ source: EA });
    expect(c.status).toBe(402);
  });
  it("does not charge for code it cannot read", async () => {
    const k = store.create("t2", 1);
    const r = await request(app).post("/v1/convert").set("X-API-Key", k).send({ source: "void OnTick( {" });
    expect(r.body.status).toBe("failed");
    expect(r.body.credits_remaining).toBe(1);
  });
  it("reports usage", async () => {
    const r = await request(app).get("/v1/usage").set("X-API-Key", key);
    expect(r.body).toMatchObject({ name: "tester", credits_remaining: 0, used: 2 });
  });
});
