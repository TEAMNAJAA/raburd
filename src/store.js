// บันทึกการใช้งานจริงของเว็บ (คำถาม / คำตอบ / ผลโหวต) เป็น JSONL แล้วแปลงกลับเป็นเคสอ้างอิง
import fs from "node:fs";
import path from "node:path";

const MAX_ANSWER_CHARS = 20000;
const MAX_CASE_ANSWER_CHARS = 2500;

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "usage.jsonl");
  const events = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // บรรทัดเสีย (เช่น เขียนค้างตอนเครื่องดับ) ข้ามไป ไม่ให้ทั้งไฟล์ใช้ไม่ได้
      }
    }
  }

  function append(event) {
    events.push(event);
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
    return event;
  }

  const asks = () => events.filter((e) => e.type === "ask");
  const has = (id) => events.some((e) => e.type === "ask" && e.id === id);

  // ผลโหวตล่าสุดของแต่ละคำถาม พร้อมความต้องการอันดับแรกที่ระบบอ่านได้ตอนนั้น
  function feedback() {
    const detected = new Map(asks().map((a) => [a.id, a.needs?.[0]]));
    const latest = new Map();
    for (const e of events) if (e.type === "feedback") latest.set(e.id, { ...e, detected: detected.get(e.id) });
    return [...latest.values()];
  }

  // คำถามที่ผู้ถามยืนยันแล้ว → เคสอ้างอิงรอบถัดไป
  // 👍 = ทั้งคำถามและคำตอบ (ที่ Claude เขียน) ใช้อ้างอิงได้ / 👎 แต่บอกความต้องการจริง = ใช้อ้างอิงเฉพาะความต้องการ
  function learnedCases(needLabel = (id) => id) {
    const answers = new Map();
    for (const e of events) if (e.type === "answer") answers.set(e.id, e);
    const byId = new Map(asks().map((a) => [a.id, a]));
    const out = [];
    for (const f of feedback()) {
      const ask = byId.get(f.id);
      if (!ask) continue;
      const need = f.need || (f.helpful ? ask.needs?.[0] : null);
      if (!need) continue;
      const ans = answers.get(f.id);
      // คำตอบโหมดฐานความรู้ประกอบมาจากเคสเดิมอยู่แล้ว ถ้าเก็บซ้ำจะได้คำตอบที่อ้างตัวเองวนไปเรื่อย ๆ
      // จึงเก็บเป็นคำตอบอ้างอิงได้เฉพาะที่ Claude เขียน — แต่ผลโหวตยังใช้สอนเรื่องความต้องการได้เสมอ
      const useAnswer = f.helpful === true && ans?.mode === "claude" && ans.text;
      out.push({
        id: "site-" + f.id,
        source: "site-usage",
        date: (ask.ts || "").slice(0, 10),
        project: "",
        question: ask.question,
        variants: [],
        needs: [need],
        real_need: f.note || needLabel(need),
        answer: useAnswer ? ans.text.slice(0, MAX_CASE_ANSWER_CHARS) : "",
        outcome: f.helpful ? "ผู้ถามยืนยันว่าตรงความต้องการ" : "ผู้ถามบอกว่าคำตอบไม่ตรง และระบุความต้องการจริง",
        lesson: f.helpful ? "" : `ระบบเคยอ่านว่าเป็น “${needLabel(ask.needs?.[0])}” แต่จริง ๆ ต้องการ “${needLabel(need)}”`,
        tags: [],
      });
    }
    return out;
  }

  return {
    file,
    events,
    has,
    asks,
    feedback,
    learnedCases,
    recordAsk: (e) => append({ type: "ask", ts: new Date().toISOString(), ...e }),
    recordAnswer: (e) =>
      append({ type: "answer", ts: new Date().toISOString(), ...e, text: String(e.text || "").slice(0, MAX_ANSWER_CHARS) }),
    recordFeedback: (e) => append({ type: "feedback", ts: new Date().toISOString(), ...e }),
  };
}
