#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { convert } from "./translator.js";

const [, , input, output] = process.argv;
if (!input) {
  console.error("Usage: mt5-to-pine <file.mq5> [out.pine]");
  process.exit(2);
}
const result = convert(readFileSync(input, "utf8"));
if (output) writeFileSync(output, result.pine);
else process.stdout.write(result.pine);
console.error(`\nstatus: ${result.status}`);
for (const i of result.issues) console.error(`  [${i.severity}] line ${i.line}: ${i.message}`);
process.exit(result.status === "failed" ? 1 : 0);
