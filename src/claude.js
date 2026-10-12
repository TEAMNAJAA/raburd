// เรียก Claude แบบ streaming เพื่อตอบคำถาม โดยมีเคสการใช้งานจริงแนบไปใน prompt
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";

// ให้ server-side fallback เลือกโมเดลสำรองเองตามประเภทการปฏิเสธ (ดีกว่าระบุโมเดลตายตัว)
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function hasCredentials(env = process.env) {
  if (env.RABURD_LLM === "off") return false;
  if (env.RABURD_LLM === "on") return true;
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}

export function createAnswerer({
  client,
  model = DEFAULT_MODEL,
  effort = "medium",
  webSearch = false,
  maxContinuations = 3,
} = {}) {
  let sdk = client;
  const getClient = () => (sdk ??= new Anthropic());

  function params(system, messages) {
    const p = {
      model,
      max_tokens: 64000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    };
    if (webSearch) p.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }];
    return p;
  }

  // คืน { text, stopReason, sources, model } — เรียก onText ทุกครั้งที่มีข้อความใหม่
  async function answer({ system, messages, onText = () => {}, signal }) {
    let convo = [...messages];
    let text = "";
    const sources = new Map();
    let final;
    for (let round = 0; round <= maxContinuations; round++) {
      if (signal?.aborted) throw new Anthropic.APIUserAbortError();
      const stream = getClient().beta.messages.stream(params(system, convo));
      const abort = () => stream.abort();
      signal?.addEventListener("abort", abort, { once: true });
      stream.on("text", (delta) => {
        text += delta;
        onText(delta);
      });
      try {
        final = await stream.finalMessage();
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      for (const block of final.content) {
        if (block.type !== "text" || !block.citations) continue;
        for (const c of block.citations) {
          if (c.url && !sources.has(c.url)) sources.set(c.url, { url: c.url, title: c.title || c.url });
        }
      }
      // web search ที่ใช้เวลานานอาจหยุดกลางทาง (pause_turn) — ส่งเนื้อหาเดิมกลับไปให้ทำต่อ
      if (final.stop_reason !== "pause_turn") break;
      convo = [...convo, { role: "assistant", content: final.content }];
    }
    return {
      text,
      stopReason: final?.stop_reason ?? null,
      refusal: final?.stop_reason === "refusal" ? final.stop_details ?? {} : null,
      sources: [...sources.values()],
      model: final?.model ?? model,
    };
  }

  return { answer, model, effort, webSearch };
}

// แปลง error จาก SDK เป็นข้อความภาษาไทยที่บอกว่าต้องทำอะไรต่อ
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "API key ของ Claude ไม่ถูกต้องหรือหมดอายุ — ตรวจค่า ANTHROPIC_API_KEY";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "API key นี้ไม่มีสิทธิ์ใช้โมเดลที่ตั้งไว้ — ตรวจค่า CLAUDE_MODEL หรือสิทธิ์ของ key";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "เรียก Claude ถี่เกินโควตา — รอสักครู่แล้วลองใหม่";
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `Claude ปฏิเสธคำขอ (400): ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "เชื่อมต่อ Claude API ไม่ได้ — ตรวจอินเทอร์เน็ตหรือ proxy";
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API ตอบกลับผิดพลาด (${err.status ?? "?"}) — ลองใหม่อีกครั้ง`;
  }
  return "เกิดข้อผิดพลาดระหว่างเรียก Claude";
}
