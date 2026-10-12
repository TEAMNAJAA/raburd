import test from "node:test";
import assert from "node:assert/strict";

import { parseClaudeAiExport, parseClaudeCodeJsonl, redact, toCases } from "../scripts/import-history.js";
import { readJson } from "./helpers.js";

const needs = readJson("public/data/needs.json").needs;

test("claude.ai export: จับคู่คำถาม → คำตอบตามลำดับเวลา พร้อมชื่อไฟล์แนบ", () => {
  const data = [
    {
      name: "โปรเจกต์ A",
      created_at: "2026-08-01T00:00:00Z",
      chat_messages: [
        { sender: "assistant", text: "ข้อ 2", created_at: "2026-08-01T00:02:00Z" },
        { sender: "human", text: "ขอแบบง่ายๆ", created_at: "2026-08-01T00:01:00Z", attachments: [{ file_name: "spec.pdf" }] },
        { sender: "human", content: [{ type: "text", text: "ยังไม่มีคำตอบ" }], created_at: "2026-08-01T00:03:00Z" },
      ],
    },
  ];
  const pairs = parseClaudeAiExport(data);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].question, "ขอแบบง่ายๆ (แนบไฟล์ spec.pdf)");
  assert.equal(pairs[0].answer, "ข้อ 2");
  assert.equal(pairs[0].session, "โปรเจกต์ A");
});

test("Claude Code JSONL: เอาเฉพาะคำถามที่คนพิมพ์ และข้อความสรุปสุดท้ายของเทิร์น", () => {
  const lines = [
    { type: "user", message: { role: "user", content: "เขียน train ให้หน่อย" }, timestamp: "2026-09-05T05:33:22Z", cwd: "/home/user/Nextgen" },
    { type: "assistant", message: { content: [{ type: "text", text: "กำลังอ่าน PDF" }, { type: "tool_use", name: "Bash" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "user", isMeta: true, message: { content: "<system-reminder>x</system-reminder>" } },
    { type: "user", message: { content: "Stop hook feedback: push" } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "เสร็จแล้ว: src/train.py" }] } },
    { type: "user", message: { content: "ไม่มีคำตอบ" } },
  ];
  const pairs = parseClaudeCodeJsonl(lines.map((l) => JSON.stringify(l)).join("\n") + "\n{broken");
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].question, "เขียน train ให้หน่อย");
  assert.equal(pairs[0].answer, "เสร็จแล้ว: src/train.py");
  assert.equal(pairs[0].project, "Nextgen");
});

test("redact ลบอีเมล คีย์ และโทเค็น", () => {
  const s = redact(
    "mail me a.b@example.co.th key sk-ant-api03-abcdefghijklmnop token ghp_abcdefghijklmnopqrstuvwxyz12 url https://x.io/?token=SECRET&a=1 Bearer abcdefghijklmnopqrstuv",
  );
  assert.doesNotMatch(s, /example\.co\.th|sk-ant|ghp_|SECRET|abcdefghijklmnopqrstuv/);
  assert.match(s, /\[ลบอีเมล\]/);
  assert.match(s, /a=1/);
});

test("toCases ให้ id คงที่ (นำเข้าซ้ำไม่ซ้ำเคส) และเดาความต้องการ", () => {
  const pairs = [{ question: "บอกมาสั้นๆ ว่ามีอะไรบ้าง", answer: "1. a", date: "2026-09-06T01:21:34Z", session: "s", project: "p" }];
  const [a] = toCases(pairs, needs);
  const [b] = toCases(pairs, needs);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^imp-[0-9a-f]{12}$/);
  assert.equal(a.date, "2026-09-06");
  assert.equal(a.needs[0], "brief");
  assert.equal(a.source, "claude-history");
});
