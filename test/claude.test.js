import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

import { createAnswerer, describeError, hasCredentials, DEFAULT_MODEL } from "../src/claude.js";

// client ปลอมที่ทำตัวเหมือน client.beta.messages.stream() ของ SDK
function fakeClient(script) {
  const calls = [];
  const client = {
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const step = script[calls.length - 1];
          const listeners = [];
          let rejectAbort;
          const aborted = new Promise((_, reject) => (rejectAbort = reject));
          return {
            on(event, cb) {
              if (event === "text") listeners.push(cb);
              return this;
            },
            abort() {
              rejectAbort(new Anthropic.APIUserAbortError());
            },
            async finalMessage() {
              if (step.hang) return aborted;
              for (const t of step.deltas || []) listeners.forEach((cb) => cb(t));
              return step.message;
            },
          };
        },
      },
    },
  };
  return { client, calls };
}

const msg = (content, stop_reason = "end_turn") => ({ model: DEFAULT_MODEL, stop_reason, stop_details: null, content });

test("ค่าเริ่มต้นของคำขอ: Opus 5.5, fallback อัตโนมัติ, effort, cache system prompt", async () => {
  const { client, calls } = fakeClient([{ deltas: ["สวัส", "ดี"], message: msg([{ type: "text", text: "สวัสดี" }]) }]);
  const a = createAnswerer({ client });
  const seen = [];
  const r = await a.answer({ system: "SYS", messages: [{ role: "user", content: "hi" }], onText: (t) => seen.push(t) });
  assert.equal(r.text, "สวัสดี");
  assert.deepEqual(seen, ["สวัส", "ดี"]);
  assert.equal(r.stopReason, "end_turn");

  const p = calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.equal(p.max_tokens, 64000);
  assert.equal(p.thinking, undefined, "Opus 5.5 ใช้ adaptive thinking เมื่อไม่ส่ง thinking");
  assert.deepEqual(p.system, [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  assert.equal(p.tools, undefined);
});

test("web search: pause_turn ส่งเนื้อหาเดิมกลับไปทำต่อ และรวมแหล่งอ้างอิง", async () => {
  const first = msg(
    [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
      { type: "text", text: "ส่วนแรก ", citations: [{ type: "web_search_result_location", url: "https://a.example", title: "A" }] },
    ],
    "pause_turn",
  );
  const second = msg([
    { type: "text", text: "ส่วนสอง", citations: [{ url: "https://a.example", title: "A" }, { url: "https://b.example", title: "B" }] },
  ]);
  const { client, calls } = fakeClient([
    { deltas: ["ส่วนแรก "], message: first },
    { deltas: ["ส่วนสอง"], message: second },
  ]);
  const a = createAnswerer({ client, webSearch: true });
  const r = await a.answer({ system: "S", messages: [{ role: "user", content: "q" }] });
  assert.equal(r.text, "ส่วนแรก ส่วนสอง");
  assert.deepEqual(r.sources.map((s) => s.url), ["https://a.example", "https://b.example"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]);
  assert.deepEqual(calls[1].messages.at(-1), { role: "assistant", content: first.content });
  assert.deepEqual(calls[1].tools, calls[0].tools, "ชุด tools ต้องเหมือนเดิมทุกรอบ");
});

test("refusal ถูกส่งต่อให้ผู้เรียกจัดการ", async () => {
  const refused = { ...msg([], "refusal"), stop_details: { type: "refusal", category: "cyber" } };
  const { client } = fakeClient([{ message: refused }]);
  const r = await createAnswerer({ client }).answer({ system: "S", messages: [{ role: "user", content: "q" }] });
  assert.equal(r.stopReason, "refusal");
  assert.equal(r.refusal.category, "cyber");
});

test("ยกเลิกได้ด้วย AbortSignal (ผู้ใช้ปิดหน้าเว็บ)", async () => {
  const { client } = fakeClient([{ hang: true }]);
  const controller = new AbortController();
  const p = createAnswerer({ client }).answer({ system: "S", messages: [{ role: "user", content: "q" }], signal: controller.signal });
  controller.abort();
  await assert.rejects(p, Anthropic.APIUserAbortError);
});

test("hasCredentials ดูจาก env และบังคับเปิด/ปิดได้", () => {
  assert.equal(hasCredentials({}), false);
  assert.equal(hasCredentials({ ANTHROPIC_API_KEY: "x" }), true);
  assert.equal(hasCredentials({ ANTHROPIC_API_KEY: "x", RABURD_LLM: "off" }), false);
  assert.equal(hasCredentials({ RABURD_LLM: "on" }), true);
});

test("describeError แยกสาเหตุจาก error class ของ SDK", () => {
  const h = new Headers();
  assert.match(describeError(new Anthropic.AuthenticationError(401, {}, "bad", h)), /API key/);
  assert.match(describeError(new Anthropic.RateLimitError(429, {}, "slow", h)), /โควตา/);
  assert.match(describeError(new Anthropic.APIConnectionError({ message: "x" })), /เชื่อมต่อ/);
  assert.match(describeError(new Error("x")), /ข้อผิดพลาด/);
});

test("SDK จริง: header/body ที่ส่งออกถูกต้อง และอ่าน SSE ได้ (fetch จำลอง ไม่ใช้เน็ต)", async () => {
  const sse = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ตอบ" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "แล้ว" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");
  let captured;
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url, init) => {
      captured = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const deltas = [];
  const r = await createAnswerer({ client }).answer({
    system: "SYS",
    messages: [{ role: "user", content: "q" }],
    onText: (t) => deltas.push(t),
  });
  assert.equal(r.text, "ตอบแล้ว");
  assert.deepEqual(deltas, ["ตอบ", "แล้ว"]);
  assert.equal(r.stopReason, "end_turn");
  assert.match(captured.url, /\/v1\/messages\?beta=true$/);
  assert.match(captured.headers.get("anthropic-beta"), /server-side-fallback-2026-07-01/);
  assert.equal(captured.body.model, "claude-opus-5-5");
  assert.equal(captured.body.fallbacks, "default");
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.betas, undefined, "betas ต้องไปอยู่ใน header ไม่ใช่ body");
  assert.deepEqual(captured.body.output_config, { effort: "medium" });
});
