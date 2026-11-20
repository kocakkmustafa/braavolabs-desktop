#!/usr/bin/env node
// Usage: node scripts/verify-latest-json.mjs path/to/latest.json
// Exit 0 = every platform entry complete; 1 = errors listed. Reads only the given file; no network, no keys.
import { readFileSync } from "node:fs";
import { validateLatestJson } from "../src/latest-json.ts";

const file = process.argv[2];
if (!file) { console.error("usage: verify-latest-json.mjs <latest.json>"); process.exit(2); }
let data;
try { data = JSON.parse(readFileSync(file, "utf8")); } catch { console.error("latest.json: unreadable or not JSON"); process.exit(1); }
const r = validateLatestJson(data);
if (r.ok) { console.log("latest.json: OK"); process.exit(0); }
for (const e of r.errors) console.error(`latest.json: ${e}`);
process.exit(1);
