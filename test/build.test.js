import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { buildPage } from "../scripts/build-artifact.js";
import { tempDir } from "./helpers.js";

test("หน้าเว็บไฟล์เดียว: มีชื่อ ฐานความรู้ครบ และสคริปต์ parse ได้", (t) => {
  const page = buildPage();
  assert.match(page.slice(0, 200), /^<title>raburd<\/title>/);
  assert.doesNotMatch(page, /<!doctype|<html|<head>|<body>/i, "หน้าเผยแพร่ต้องไม่มี skeleton ของตัวเอง");
  assert.doesNotMatch(page, /src="app\.js"|href="styles\.css"/);

  const data = JSON.parse(page.match(/<script type="application\/json" id="raburd-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.needs.length, 8);
  assert.ok(data.cases.some((c) => c.id === "github-push-403"));

  const js = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.match(js, /const engine = __engine;/);
  const file = path.join(tempDir(t), "bundle.mjs");
  fs.writeFileSync(file, js);
  execFileSync(process.execPath, ["--check", file]);
});
