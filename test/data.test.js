import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { renderMarkdown } from "../public/markdown.js";
import { PUBLIC, readJson } from "./helpers.js";

const needs = readJson("public/data/needs.json").needs;
const needIds = new Set([...needs.map((n) => n.id), "general"]);
const dir = path.join(PUBLIC, "data", "knowledge");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
const cases = files.flatMap((f) => readJson(`public/data/knowledge/${f}`).cases);

test("index.json (ใช้ในโหมด static) ตรงกับไฟล์เคสในโฟลเดอร์", () => {
  assert.deepEqual([...readJson("public/data/knowledge/index.json").files].sort(), files.sort());
});

test("ทุกเคสมีข้อมูลครบ id ไม่ซ้ำ และใช้ประเภทความต้องการที่มีอยู่จริง", () => {
  const ids = new Set();
  for (const c of cases) {
    assert.ok(c.id && c.question && c.source && c.date, JSON.stringify(c).slice(0, 80));
    assert.ok(!ids.has(c.id), `id ซ้ำ ${c.id}`);
    ids.add(c.id);
    assert.ok(c.needs?.length, `${c.id} ต้องมี needs`);
    for (const n of c.needs) assert.ok(needIds.has(n), `${c.id}: ไม่รู้จัก need ${n}`);
  }
});

test("evidence ของแต่ละความต้องการชี้ไปที่เคสที่มีอยู่จริง", () => {
  const ids = new Set(cases.map((c) => c.id));
  for (const n of needs) {
    assert.ok(n.signals.length && n.guidance && n.ask, n.id);
    for (const e of n.evidence) assert.ok(ids.has(e), `${n.id} → ${e}`);
  }
});

test("ข้อมูลที่เผยแพร่ไม่มีอีเมลหรือคีย์", () => {
  const raw = fs.readdirSync(path.join(PUBLIC, "data"), { recursive: true })
    .filter((f) => f.endsWith(".json"))
    .map((f) => fs.readFileSync(path.join(PUBLIC, "data", f), "utf8"))
    .join("\n");
  assert.doesNotMatch(raw, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(raw, /sk-ant-|ghp_|github_pat_/);
});

test("markdown: escape HTML ทุกจุด และลิงก์ได้เฉพาะ http(s)", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **b** [x](javascript:alert(1)) `<b>`\n\n```js\n<script>\n```');
  assert.doesNotMatch(html, /<img|<script|href="javascript/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  assert.match(html, /<pre data-lang="js"><code>&lt;script&gt;<\/code><\/pre>/);
});

test("markdown: ตาราง ลิสต์ และอ้างอิงเคส", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n1. หนึ่ง\n2. สอง\n\nดู [เคส: github-push-403]");
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/);
  assert.match(html, /<ol><li>หนึ่ง<\/li><li>สอง<\/li><\/ol>/);
  assert.match(html, /<span class="cite">เคส: github-push-403<\/span>/);
});
