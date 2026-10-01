// Manage API keys: tsx src/admin.ts create <name> <credits> | add <name> <credits> | list
import { KeyStore } from "./keys.js";

const store = new KeyStore(process.env.KEYS_FILE ?? "data/keys.json");
const [, , cmd, name, credits] = process.argv;

switch (cmd) {
  case "create": {
    if (!name) throw new Error("usage: create <name> [credits]");
    const key = store.create(name, Number(credits ?? 50));
    console.log(`API key for ${name} (shown once, store it safely):\n${key}`);
    break;
  }
  case "add":
    if (!name || !credits) throw new Error("usage: add <name> <credits>");
    console.log(store.addCredits(name, Number(credits)) ? "ok" : "no key with that name");
    break;
  case "list":
    for (const r of store.list()) console.log(`${r.name}\tcredits=${r.credits}\tused=${r.used}\tlast=${r.lastUsedAt ?? "-"}`);
    break;
  default:
    console.log("usage: tsx src/admin.ts create <name> [credits] | add <name> <credits> | list");
}
