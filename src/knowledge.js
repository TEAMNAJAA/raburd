// โหลดฐานความรู้: ประเภทความต้องการ, โปรไฟล์, และเคสการใช้งานจริง
//   public/data/knowledge/*.json   เคสที่เผยแพร่ได้ (อยู่ใน repo)
//   <DATA_DIR>/knowledge/*.json     เคสส่วนตัวจาก npm run import-history (ไม่เข้า git)
import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function caseFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadKnowledge({ publicDir, dataDir }) {
  const needs = readJson(path.join(publicDir, "data", "needs.json")).needs;
  const profile = readJson(path.join(publicDir, "data", "profile.json"));
  const cases = [];
  const seen = new Set();
  const add = (file, isPrivate) => {
    for (const c of readJson(file).cases || []) {
      if (!c.id || !c.question) throw new Error(`${file}: ทุกเคสต้องมี id และ question`);
      if (seen.has(c.id)) throw new Error(`${file}: id ซ้ำ "${c.id}"`);
      seen.add(c.id);
      cases.push(isPrivate ? { ...c, private: true } : c);
    }
  };
  for (const f of caseFiles(path.join(publicDir, "data", "knowledge"))) add(f, false);
  for (const f of caseFiles(path.join(dataDir, "knowledge"))) add(f, true);
  return { needs, profile, cases };
}
