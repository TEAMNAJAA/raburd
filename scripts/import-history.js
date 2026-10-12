#!/usr/bin/env node
// นำเข้าประวัติการใช้ Claude เป็นเคสอ้างอิงของ raburd
//
//   npm run import-history -- <ไฟล์หรือโฟลเดอร์> [...] [--dry-run] [--public] [--out <file>]
//
// รองรับ
//   - claude.ai: Settings → Privacy → Export data → แตก zip → conversations.json
//   - Claude Code: ~/.claude/projects/<โปรเจกต์>/*.jsonl
//
// ค่าเริ่มต้นเขียนลง <RABURD_DATA_DIR>/knowledge/imported.json (ส่วนตัว ไม่เข้า git)
// --public เขียนลง public/data/knowledge/imported.json (เผยแพร่ไปกับเว็บ — ตรวจเนื้อหาก่อน)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { detectNeeds } from "../public/engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_QUESTION = 1500;
const MAX_ANSWER = 2500;

// ---------------------------------------------------------------- ลบข้อมูลอ่อนไหว

const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "[ลบ API key]"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "[ลบ API key]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[ลบ GitHub token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[ลบ GitHub token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[ลบ Slack token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[ลบ AWS key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [ลบโทเค็น]"],
  [/([?&](?:token|key|access_token|api_key|signature|sig)=)[^&\s]+/gi, "$1[ลบ]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[ลบอีเมล]"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "[ลบค่า hash/โทเค็น]"],
];

export function redact(text) {
  let out = String(text ?? "");
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function clip(text, n) {
  const s = String(text ?? "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------- claude.ai export

function messageText(m) {
  if (Array.isArray(m.content) && m.content.length) {
    const t = m.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (t.trim()) return t;
  }
  return typeof m.text === "string" ? m.text : "";
}

export function parseClaudeAiExport(data) {
  const conversations = Array.isArray(data) ? data : data?.conversations || [];
  const pairs = [];
  for (const conv of conversations) {
    const msgs = [...(conv.chat_messages || [])].sort((a, b) =>
      String(a.created_at || "").localeCompare(String(b.created_at || "")),
    );
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.sender !== "human") continue;
      let q = messageText(m).trim();
      const files = [...(m.attachments || []), ...(m.files || [])].map((f) => f.file_name).filter(Boolean);
      if (files.length) q = `${q} (แนบไฟล์ ${files.join(", ")})`.trim();
      if (!q) continue;
      const answers = [];
      for (let j = i + 1; j < msgs.length && msgs[j].sender !== "human"; j++) answers.push(messageText(msgs[j]));
      const a = answers.join("\n\n").trim();
      if (!a) continue;
      pairs.push({ question: q, answer: a, date: m.created_at || conv.created_at, session: conv.name || "", project: "claude.ai" });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------- Claude Code JSONL

const META_PREFIXES = ["<command-name>", "<local-command", "<command-message>", "Caveat:", "<task-notification>", "<system-reminder>", "Stop hook feedback"];

function humanPrompt(entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isSynthetic) return null;
  const c = entry.message?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return null;
    text = c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  }
  text = text.trim();
  if (!text || META_PREFIXES.some((p) => text.startsWith(p))) return null;
  return text;
}

export function parseClaudeCodeJsonl(text, { project = "" } = {}) {
  const entries = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ข้ามบรรทัดที่อ่านไม่ได้
    }
  }
  const pairs = [];
  let current = null;
  const flush = () => {
    if (current && current.answer) pairs.push(current);
    current = null;
  };
  for (const e of entries) {
    const q = humanPrompt(e);
    if (q) {
      flush();
      current = { question: q, answer: "", date: e.timestamp, session: e.sessionId || "", project: project || path.basename(e.cwd || "") };
      continue;
    }
    if (current && e.type === "assistant" && !e.isSidechain && Array.isArray(e.message?.content)) {
      const t = e.message.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
      // ข้อความสุดท้ายของเทิร์นคือสรุปที่ผู้ใช้เห็น จึงเก็บอันล่าสุด
      if (t) current.answer = t;
    }
  }
  flush();
  return pairs;
}

// ---------------------------------------------------------------- pairs → cases

export function toCases(pairs, needs) {
  return pairs.map((p) => {
    const question = clip(redact(p.question), MAX_QUESTION);
    const detected = detectNeeds(question, needs).map((n) => n.id);
    const id = "imp-" + createHash("sha1").update(`${p.date}|${p.question}`).digest("hex").slice(0, 12);
    return {
      id,
      source: "claude-history",
      session: clip(redact(p.session), 120),
      date: String(p.date || "").slice(0, 10),
      project: clip(redact(p.project), 80),
      question,
      variants: [],
      needs: detected,
      real_need: "",
      answer: clip(redact(p.answer), MAX_ANSWER),
      outcome: "",
      lesson: "",
      tags: [],
    };
  });
}

function collect(input) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    const out = [];
    for (const name of fs.readdirSync(input).sort()) {
      const p = path.join(input, name);
      if (name === "conversations.json" || name.endsWith(".jsonl") || fs.statSync(p).isDirectory()) out.push(...collect(p));
    }
    return out;
  }
  if (input.endsWith(".jsonl")) {
    return parseClaudeCodeJsonl(fs.readFileSync(input, "utf8"), { project: path.basename(path.dirname(input)) });
  }
  if (input.endsWith(".json")) return parseClaudeAiExport(JSON.parse(fs.readFileSync(input, "utf8")));
  throw new Error(`ไม่รู้จักชนิดไฟล์: ${input} (ต้องเป็น conversations.json หรือ *.jsonl)`);
}

// ---------------------------------------------------------------- main

function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--") && a !== "--out"));
  const outIdx = args.indexOf("--out");
  const inputs = args.filter((a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1));
  if (!inputs.length) {
    console.error("ใช้: npm run import-history -- <conversations.json | ไฟล์ .jsonl | โฟลเดอร์> [--dry-run] [--public] [--out file]");
    process.exit(1);
  }
  const needs = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/needs.json"), "utf8")).needs;
  const pairs = inputs.flatMap(collect);
  const cases = toCases(pairs, needs);

  const isPublic = flags.has("--public");
  const out =
    outIdx >= 0
      ? path.resolve(args[outIdx + 1])
      : isPublic
        ? path.join(ROOT, "public/data/knowledge/imported.json")
        : path.join(path.resolve(process.env.RABURD_DATA_DIR || path.join(ROOT, ".data")), "knowledge/imported.json");

  const existing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")).cases || [] : [];
  const merged = new Map(existing.map((c) => [c.id, c]));
  let added = 0;
  for (const c of cases) {
    if (!merged.has(c.id)) added += 1;
    merged.set(c.id, c);
  }

  console.log(`อ่านได้ ${pairs.length} คู่ คำถาม→คำตอบ · ใหม่ ${added} · รวม ${merged.size} เคส`);
  for (const c of cases.slice(0, 5)) console.log(`  - [${c.needs.join(",")}] ${c.question.slice(0, 80)}`);
  if (flags.has("--dry-run")) {
    console.log("(--dry-run: ยังไม่เขียนไฟล์)");
    return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const about = "เคสที่นำเข้าจากประวัติการใช้ Claude ด้วย scripts/import-history.js (ลบอีเมล/คีย์/โทเค็นแล้ว)";
  fs.writeFileSync(out, JSON.stringify({ _about: about, cases: [...merged.values()] }, null, 2) + "\n");
  console.log(`เขียนแล้ว: ${out}`);
  if (isPublic) {
    const indexFile = path.join(ROOT, "public/data/knowledge/index.json");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    const name = path.basename(out);
    if (path.dirname(out) === path.dirname(indexFile) && !index.files.includes(name)) {
      index.files.push(name);
      fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n");
    }
  }
  console.log("รีสตาร์ตเซิร์ฟเวอร์เพื่อโหลดเคสใหม่");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
