import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createKnowledge } from "../public/engine.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC = path.join(ROOT, "public");

export const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

export function loadKb(extra = {}) {
  return createKnowledge({
    needs: readJson("public/data/needs.json").needs,
    profile: readJson("public/data/profile.json"),
    cases: readJson("public/data/knowledge/claude-history.json").cases,
    ...extra,
  });
}

export function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raburd-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
