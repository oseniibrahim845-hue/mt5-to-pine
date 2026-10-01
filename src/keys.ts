// API keys with conversion credits, stored in a small JSON file.

import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface KeyRecord {
  name: string;
  credits: number; // remaining conversions
  used: number;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeyFile {
  // keyed by sha256 of the API key, so the file never holds the raw keys
  keys: Record<string, KeyRecord>;
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export class KeyStore {
  private data: KeyFile;

  constructor(private path: string) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as KeyFile) : { keys: {} };
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  create(name: string, credits: number): string {
    const key = "m2p_" + randomBytes(24).toString("base64url");
    this.data.keys[hash(key)] = { name, credits, used: 0, createdAt: new Date().toISOString(), lastUsedAt: null };
    this.save();
    return key;
  }

  get(key: string): KeyRecord | undefined {
    return this.data.keys[hash(key)];
  }

  /** Take one credit. Returns the updated record, or null if the key is unknown or empty. */
  spend(key: string): KeyRecord | null {
    const rec = this.data.keys[hash(key)];
    if (!rec || rec.credits <= 0) return null;
    rec.credits -= 1;
    rec.used += 1;
    rec.lastUsedAt = new Date().toISOString();
    this.save();
    return rec;
  }

  /** Give a credit back (e.g. when conversion failed to read the file). */
  refund(key: string) {
    const rec = this.data.keys[hash(key)];
    if (!rec) return;
    rec.credits += 1;
    rec.used = Math.max(0, rec.used - 1);
    this.save();
  }

  addCredits(name: string, credits: number): boolean {
    const rec = Object.values(this.data.keys).find((r) => r.name === name);
    if (!rec) return false;
    rec.credits += credits;
    this.save();
    return true;
  }

  list(): KeyRecord[] {
    return Object.values(this.data.keys);
  }
}
