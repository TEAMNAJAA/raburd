// บันทึกการใช้งานจริงของเว็บ (คำถาม / คำตอบ / ผลโหวต) เป็น JSONL
// แล้วรวมเป็นหนึ่งแถวต่อคำถามให้ learnFromUsage() ใน engine แปลงเป็นเคสอ้างอิง
import fs from "node:fs";
import path from "node:path";

const MAX_ANSWER_CHARS = 20000;

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

  // หนึ่งแถวต่อคำถาม: คำถาม + คำตอบล่าสุด + ผลโหวตล่าสุด
  function records() {
    const rows = new Map();
    for (const e of events) {
      if (e.type === "ask") {
        rows.set(e.id, { id: e.id, question: e.question, ts: e.ts, needs: e.needs, cases: e.cases, mode: e.mode });
        continue;
      }
      const row = rows.get(e.id);
      if (!row) continue;
      if (e.type === "answer") Object.assign(row, { answer: e.text, answerMode: e.mode });
      if (e.type === "feedback") Object.assign(row, { helpful: e.helpful, need: e.need, note: e.note });
    }
    return [...rows.values()];
  }

  return {
    file,
    has: (id) => events.some((e) => e.type === "ask" && e.id === id),
    records,
    recordAsk: (e) => append({ type: "ask", ts: new Date().toISOString(), ...e }),
    recordAnswer: (e) =>
      append({ type: "answer", ts: new Date().toISOString(), ...e, text: String(e.text || "").slice(0, MAX_ANSWER_CHARS) }),
    recordFeedback: (e) => append({ type: "feedback", ts: new Date().toISOString(), ...e }),
  };
}
