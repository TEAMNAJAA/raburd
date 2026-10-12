// raburd — เว็บถาม-ตอบที่อ่านความต้องการจริงของคำถามจากข้อมูลการใช้งานจริง
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  analyze,
  buildSystemPrompt,
  buildUserContent,
  composeOfflineAnswer,
  createKnowledge,
  needById,
  summarizeUsage,
  GENERAL_NEED,
} from "./public/engine.js";
import { loadKnowledge } from "./src/knowledge.js";
import { openStore } from "./src/store.js";
import { createAnswerer, describeError, hasCredentials, DEFAULT_MODEL } from "./src/claude.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const MAX_QUESTION = 4000;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 8000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const publicDir = options.publicDir ?? path.join(ROOT, "public");
  const dataDir = path.resolve(options.dataDir ?? env.RABURD_DATA_DIR ?? path.join(ROOT, ".data"));
  const hidePrivate = env.RABURD_HIDE_PRIVATE === "1";
  const showQuestions = env.INSIGHTS_SHOW_QUESTIONS === "1";
  const rateLimit = Number(env.RATE_LIMIT ?? 30);

  const base = loadKnowledge({ publicDir, dataDir });
  const store = options.store ?? openStore(dataDir);
  const llm = options.answerer
    ? options.answerer
    : hasCredentials(env)
      ? createAnswerer({
          model: env.CLAUDE_MODEL || DEFAULT_MODEL,
          effort: env.CLAUDE_EFFORT || "medium",
          webSearch: env.ENABLE_WEB_SEARCH === "1",
        })
      : null;

  let kb;
  const rebuild = () => {
    const label = (id) => needById({ needs: base.needs }, id).label;
    kb = createKnowledge({
      ...base,
      cases: [...base.cases, ...store.learnedCases(label)],
      feedback: store.feedback(),
    });
  };
  rebuild();
  // system prompt ขึ้นกับประเภทความต้องการและโปรไฟล์เท่านั้น จึงคงที่ทั้ง process (prompt cache ใช้ซ้ำได้)
  const systemPrompt = buildSystemPrompt(kb);

  const hits = new Map();
  function allow(ip) {
    if (!rateLimit) return true;
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= rateLimit) return false;
    recent.push(now);
    hits.set(ip, recent);
    return true;
  }

  function publicCase(c) {
    const out = {
      id: c.id,
      source: c.source,
      date: c.date,
      project: c.project,
      question: c.question,
      needs: c.needs,
      real_need: c.real_need,
      answer: c.answer,
      outcome: c.outcome,
      lesson: c.lesson,
      tags: c.tags,
      private: c.private || undefined,
    };
    if (c.private && hidePrivate) {
      return { id: c.id, source: c.source, date: c.date, needs: c.needs, question: "(เคสส่วนตัว)", private: true };
    }
    return out;
  }

  // ---------------------------------------------------------------- API

  async function ask(req, res) {
    const ip = req.socket.remoteAddress || "?";
    if (!allow(ip)) throw new HttpError(429, "ถามถี่เกินไป ลองใหม่ในอีกไม่กี่นาที");
    const body = await readJson(req);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) throw new HttpError(400, "กรุณาพิมพ์คำถาม");
    if (question.length > MAX_QUESTION) throw new HttpError(400, `คำถามยาวเกิน ${MAX_QUESTION} ตัวอักษร`);
    const history = sanitizeHistory(body.history);

    const id = randomUUID();
    const analysis = analyze(question, kb, { context: history.at(-1)?.q || "" });
    const mode = llm ? "claude" : "offline";
    store.recordAsk({
      id,
      question,
      needs: analysis.needs.map((n) => n.id),
      cases: analysis.cases.map((c) => ({ id: c.case.id, similarity: c.similarity })),
      mode,
    });

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    send("analysis", {
      id,
      mode,
      needs: analysis.needs,
      cases: analysis.cases.map((c) => ({ ...publicCase(c.case), similarity: c.similarity })),
    });

    let text = "";
    let finalMode = mode;
    let stopReason = null;
    if (llm) {
      const messages = [];
      for (const turn of history) {
        messages.push({ role: "user", content: turn.q }, { role: "assistant", content: turn.a });
      }
      messages.push({ role: "user", content: buildUserContent(analysis, kb) });
      try {
        const r = await llm.answer({
          system: systemPrompt,
          messages,
          signal: controller.signal,
          onText: (t) => send("delta", { text: t }),
        });
        text = r.text;
        stopReason = r.stopReason;
        if (r.sources.length) send("sources", { sources: r.sources });
        if (r.refusal) send("notice", { message: "Claude ไม่สามารถตอบคำถามนี้ได้ตามนโยบายความปลอดภัย" });
        if (stopReason === "max_tokens") send("notice", { message: "คำตอบยาวเกินกำหนดและถูกตัดท้าย" });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error(`[ask ${id}] Claude error:`, err?.status ?? "", err?.message ?? err);
        text = composeOfflineAnswer(analysis, kb);
        finalMode = "offline";
        send("notice", { message: describeError(err) + " — แสดงคำตอบจากฐานความรู้แทน" });
        send("replace", { text });
      }
    } else {
      text = composeOfflineAnswer(analysis, kb);
      send("delta", { text });
    }
    store.recordAnswer({ id, text, mode: finalMode, stopReason });
    send("done", { id, mode: finalMode, stopReason, model: finalMode === "claude" ? llm.model : null });
    res.end();
  }

  async function feedback(req, res) {
    const body = await readJson(req);
    const id = typeof body.id === "string" ? body.id : "";
    if (!store.has(id)) throw new HttpError(404, "ไม่พบคำถามนี้");
    if (typeof body.helpful !== "boolean") throw new HttpError(400, "helpful ต้องเป็น true หรือ false");
    const validNeeds = new Set([...kb.needs.map((n) => n.id), GENERAL_NEED.id]);
    const need = body.need == null || body.need === "" ? null : String(body.need);
    if (need && !validNeeds.has(need)) throw new HttpError(400, "ไม่รู้จักประเภทความต้องการนี้");
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    store.recordFeedback({ id, helpful: body.helpful, need, note });
    rebuild();
    json(res, 200, { ok: true });
  }

  function status(res) {
    json(res, 200, {
      ok: true,
      mode: llm ? "claude" : "offline",
      model: llm?.model ?? null,
      webSearch: Boolean(llm?.webSearch),
      cases: kb.cases.length,
      needs: kb.needs.length,
    });
  }

  function knowledge(res) {
    json(res, 200, {
      needs: kb.needs.map(({ id, label, description, guidance, evidence }) => ({ id, label, description, guidance, evidence })),
      profile: kb.profile,
      cases: kb.cases.map(publicCase),
    });
  }

  function insights(res) {
    const asks = store.asks();
    const summary = summarizeUsage(kb, asks, store.feedback());
    if (showQuestions) {
      const fb = new Map(store.feedback().map((f) => [f.id, f]));
      summary.recent = asks
        .slice(-15)
        .reverse()
        .map((a) => ({ question: a.question, ts: a.ts, need: a.needs?.[0], helpful: fb.get(a.id)?.helpful ?? null }));
    }
    json(res, 200, summary);
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/status":
        return status(res);
      case "GET /api/knowledge":
        return knowledge(res);
      case "GET /api/insights":
        return insights(res);
      case "POST /api/ask":
        return ask(req, res);
      case "POST /api/feedback":
        return feedback(req, res);
      default:
        throw new HttpError(404, "ไม่พบ API นี้");
    }
  }

  // ---------------------------------------------------------------- static

  function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "Bad path");
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || rel.split("/").some((p) => p.startsWith("."))) {
      throw new HttpError(404, "Not found");
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new HttpError(404, "Not found");
    }
    if (!stat.isFile()) throw new HttpError(404, "Not found");
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      json(res, status, { error: status === 500 ? "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" : err.message });
    }
  });

  return { server, store, get kb() { return kb; }, mode: llm ? "claude" : "offline" };
}

// ---------------------------------------------------------------- helpers

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "ข้อมูลใหญ่เกินไป"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON object)"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && typeof t.q === "string" && typeof t.a === "string" && t.q.trim() && t.a.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ q: t.q.slice(0, MAX_HISTORY_CHARS), a: t.a.slice(0, MAX_HISTORY_CHARS) }));
}

// ---------------------------------------------------------------- main

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const app = createApp();
  app.server.listen(port, host, () => {
    const how =
      app.mode === "claude"
        ? `ตอบด้วย Claude (${process.env.CLAUDE_MODEL || DEFAULT_MODEL})`
        : "โหมดฐานความรู้ (ตั้ง ANTHROPIC_API_KEY เพื่อให้ Claude ตอบ)";
    console.log(`raburd พร้อมที่ http://${host === "0.0.0.0" ? "localhost" : host}:${port} — ${how}`);
    console.log(`เคสอ้างอิง ${app.kb.cases.length} เคส · บันทึกการใช้งานที่ ${app.store.file}`);
  });
}
