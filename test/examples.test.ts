import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { convert } from "../src/translator.js";

const dir = join(__dirname, "..", "examples");
const examples = readdirSync(dir).filter((f) => f.endsWith(".mq5"));

describe("example EAs", () => {
  for (const f of examples) {
    it(`${f} converts fully and matches the saved Pine`, () => {
      const res = convert(readFileSync(join(dir, f), "utf8"));
      expect(res.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(res.status).toBe("full");
      const golden = join(dir, f.replace(/\.mq5$/, ".pine"));
      expect(res.pine).toBe(readFileSync(golden, "utf8"));
    });
  }
});

// Optional: run the Pine through PineForge's transpiler when it is installed locally.
const py = process.env.PINEFORGE_PYTHON;
describe.skipIf(!py || !existsSync(py))("PineForge transpile", () => {
  it("accepts every converted example", () => {
    const files = examples.map((f) => join(dir, f.replace(/\.mq5$/, ".pine")));
    const out = execFileSync(py!, [join(__dirname, "..", "scripts", "pineforge_check.py"), ...files], { encoding: "utf8" });
    for (const line of out.trim().split("\n")) expect(JSON.parse(line).ok).toBe(true);
  });
});
