import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createApp } from "../server.js";
import { tempDir } from "./helpers.js";

async function start(t, options = {}) {
  const dataDir = options.dataDir ?? tempDir(t);
  const app = createApp({ dataDir, env: { RABURD_LLM: "off", ...options.env }, answerer: options.answerer });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, dataDir };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.*)$/m)?.[1];
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

async function ask(base, body) {
  const res = await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, events: res.ok ? parseSse(await res.text()) : [], json: res.ok ? null : await res.json() };
}

const feedback = (base, body) =>
  fetch(`${base}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("status บอกโหมดและจำนวนเคส", async (t) => {
  const { base } = await start(t);
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.mode, "offline");
  assert.ok(s.cases >= 8);
  assert.equal(s.needs, 8);
});

test("ask (ไม่มี Claude) ส่ง analysis → delta → done และบันทึกการใช้งาน", async (t) => {
  const { base, dataDir } = await start(t);
  const { res, events } = await ask(base, { question: "ทำไม push ขึ้น github ไม่ได้ 403" });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.deepEqual(events.map((e) => e.event), ["analysis", "delta", "done"]);
  const [analysis, delta, done] = events.map((e) => e.data);
  assert.equal(analysis.needs[0].id, "unblock");
  assert.equal(analysis.cases[0].id, "github-push-403");
  assert.match(delta.text, /GitHub App/);
  assert.equal(done.mode, "offline");
  const log = fs.readFileSync(path.join(dataDir, "usage.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(log.map((e) => e.type), ["ask", "answer"]);
  assert.equal(log[0].id, analysis.id);
});

test("ตรวจข้อมูลเข้า: คำถามว่าง / JSON ผิด / ยาวเกิน", async (t) => {
  const { base } = await start(t);
  assert.equal((await ask(base, { question: "   " })).res.status, 400);
  const bad = await fetch(`${base}/api/ask`, { method: "POST", body: "not json" });
  assert.equal(bad.status, 400);
  assert.equal((await ask(base, { question: "ก".repeat(4001) })).res.status, 400);
});

test("rate limit ต่อ IP", async (t) => {
  const { base } = await start(t, { env: { RATE_LIMIT: "2" } });
  assert.equal((await ask(base, { question: "หนึ่ง" })).res.status, 200);
  assert.equal((await ask(base, { question: "สอง" })).res.status, 200);
  const third = await ask(base, { question: "สาม" });
  assert.equal(third.res.status, 429);
});

test("feedback ตรวจ id/need และ 👎 + ความต้องการจริง ถูกใช้สอนการอ่านความต้องการ", async (t) => {
  const { base, app } = await start(t);
  const q = "อยากรู้ว่าระบบ fallback ทำงานยังไง";
  const first = (await ask(base, { question: q })).events[0].data;
  assert.equal((await feedback(base, { id: "nope", helpful: true })).status, 404);
  assert.equal((await feedback(base, { id: first.id, helpful: "yes" })).status, 400);
  assert.equal((await feedback(base, { id: first.id, helpful: false, need: "made-up" })).status, 400);
  const ok = await feedback(base, { id: first.id, helpful: false, need: "deliverable", note: "อยากได้โค้ดตัวอย่าง" });
  assert.equal(ok.status, 200);

  const learned = app.kb.cases.find((c) => c.id === `site-${first.id}`);
  assert.equal(learned.source, "site-usage");
  assert.deepEqual(learned.needs, ["deliverable"]);
  assert.equal(learned.answer, "", "คำตอบที่ถูกโหวตว่าไม่ตรงต้องไม่ถูกนำไปใช้ซ้ำ");

  const again = (await ask(base, { question: q })).events[0].data;
  const d = again.needs.find((n) => n.id === "deliverable");
  assert.ok(d, "คำถามเดิมครั้งถัดไปต้องอ่านความต้องการจริงที่ผู้ถามบอกไว้ได้");
  assert.ok(d.reasons.some((r) => r.includes("คำถามในเว็บที่คล้ายกัน")));
});

test("คำตอบโหมดฐานความรู้ที่ได้ 👍 ไม่ถูกเก็บเป็นคำตอบซ้ำ (กันคำตอบอ้างตัวเองวนลูป)", async (t) => {
  const { base, app } = await start(t);
  const a = (await ask(base, { question: "เอาไฟล์ jupyter มาให้รันใน kaggle" })).events[0].data;
  await feedback(base, { id: a.id, helpful: true, need: "deliverable" });
  const learned = app.kb.cases.find((c) => c.id === `site-${a.id}`);
  assert.equal(learned.answer, "");
  const next = (await ask(base, { question: "เอาไฟล์ jupyter มาให้รันใน kaggle" })).events;
  assert.ok(!next[0].data.cases.some((c) => c.source === "site-usage"));
  assert.doesNotMatch(next[1].data.text, /ตรงกับคำถามจริงที่เคยถาม\*\* — “เอาไฟล์/);
});

test("ใช้ Claude: ส่ง prompt ที่มีเคสจริง, stream ข้อความ, คำตอบที่ได้ 👍 กลายเป็นเคสอ้างอิง", async (t) => {
  const calls = [];
  const answerer = {
    model: "claude-opus-5-5",
    webSearch: false,
    async answer({ system, messages, onText }) {
      calls.push({ system, messages });
      onText("ใช้ ");
      onText("**Adam**");
      return { text: "ใช้ **Adam**", stopReason: "end_turn", refusal: null, sources: [{ url: "https://example.com", title: "ex" }] };
    },
  };
  const { base, app } = await start(t, { answerer });
  const { events } = await ask(base, {
    question: "ควรใช้ Adam หรือ SGD ดี",
    history: [{ q: "เขียน train ให้หน่อย", a: "นี่คือโค้ด…" }, { q: "", a: "ข้าม" }],
  });
  assert.deepEqual(events.map((e) => e.event), ["analysis", "delta", "delta", "sources", "done"]);
  assert.equal(events.at(-1).data.mode, "claude");

  const { system, messages } = calls[0];
  assert.match(system, /<user_profile>/);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"], "ประวัติแชทที่ว่างถูกตัดทิ้ง");
  assert.match(messages.at(-1).content, /<detected_needs>[\s\S]*decide/);
  assert.match(messages.at(-1).content, /<question>\nควรใช้ Adam หรือ SGD ดี\n<\/question>/);

  const id = events[0].data.id;
  await feedback(base, { id, helpful: true });
  const learned = app.kb.cases.find((c) => c.id === `site-${id}`);
  assert.equal(learned.answer, "ใช้ **Adam**");
  assert.deepEqual(learned.needs, ["decide"]);
  const next = (await ask(base, { question: "Adam กับ SGD อันไหนดี" })).events[0].data;
  assert.equal(next.cases[0].id, `site-${id}`);
});

test("Claude ล้มเหลว → แจ้งเหตุผลและแทนที่ด้วยคำตอบจากฐานความรู้", async (t) => {
  const answerer = {
    model: "claude-opus-5-5",
    async answer({ onText }) {
      onText("ข้อความครึ่ง");
      throw new Error("boom");
    },
  };
  const { base, dataDir } = await start(t, { answerer });
  const { events } = await ask(base, { question: "push ไม่ได้ 403" });
  const names = events.map((e) => e.event);
  assert.deepEqual(names, ["analysis", "delta", "notice", "replace", "done"]);
  assert.match(events[3].data.text, /GitHub App/);
  assert.equal(events.at(-1).data.mode, "offline");
  const answer = fs.readFileSync(path.join(dataDir, "usage.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(answer.mode, "offline");
});

test("insights: สรุปรวม และซ่อนคำถามรายข้อเป็นค่าเริ่มต้น", async (t) => {
  const hidden = await start(t);
  await ask(hidden.base, { question: "ขอแบบง่ายๆ" });
  const s = await (await fetch(`${hidden.base}/api/insights`)).json();
  assert.equal(s.questions, 1);
  assert.equal(s.recent, undefined);

  const shown = await start(t, { env: { INSIGHTS_SHOW_QUESTIONS: "1" } });
  await ask(shown.base, { question: "ขอแบบง่ายๆ" });
  const s2 = await (await fetch(`${shown.base}/api/insights`)).json();
  assert.equal(s2.recent[0].question, "ขอแบบง่ายๆ");
});

test("เคสส่วนตัวจาก DATA_DIR ใช้ค้นได้ และซ่อนเนื้อหาได้ด้วย RABURD_HIDE_PRIVATE", async (t) => {
  const dataDir = tempDir(t);
  fs.mkdirSync(path.join(dataDir, "knowledge"));
  fs.writeFileSync(
    path.join(dataDir, "knowledge", "imported.json"),
    JSON.stringify({ cases: [{ id: "imp-1", source: "claude-history", question: "สูตรแกงเขียวหวานไก่", needs: ["explain"], answer: "ใช้พริกแกงเขียวหวาน" }] }),
  );
  const { base } = await start(t, { dataDir, env: { RABURD_HIDE_PRIVATE: "1" } });
  const k = await (await fetch(`${base}/api/knowledge`)).json();
  const c = k.cases.find((x) => x.id === "imp-1");
  assert.equal(c.question, "(เคสส่วนตัว)");
  assert.equal(c.answer, undefined);
  const { events } = await ask(base, { question: "สูตรแกงเขียวหวานไก่" });
  assert.equal(events[0].data.cases[0].id, "imp-1");
  assert.match(events[1].data.text, /พริกแกงเขียวหวาน/);
});

test("ไฟล์ static: เสิร์ฟจาก public พร้อม CSP และกัน path traversal", async (t) => {
  const { base } = await start(t);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await home.text(), /raburd/);
  assert.equal((await fetch(`${base}/engine.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  for (const p of ["/%2e%2e/package.json", "/..%2fserver.js", "/data/../../server.js", "/.hidden"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
