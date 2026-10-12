#!/usr/bin/env node
// รวมเว็บทั้งหมด (HTML + CSS + JS + ฐานความรู้) เป็นไฟล์เดียว สำหรับเผยแพร่เป็นหน้าเว็บใน Claude
// (Artifact) — ในนั้น Claude ตอบผ่านบัญชีของผู้เปิดหน้า และบันทึกการใช้งานลง db ของหน้า
//
//   node scripts/build-artifact.js [--out dist/raburd-artifact.html]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// โมดูล ES → ฟังก์ชันที่คืน object ของสิ่งที่ export (กันชื่อชนกันระหว่างไฟล์)
function wrapModule(name, src) {
  const names = [...src.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]);
  const body = src.replace(/^export (?=(?:async )?(?:function|const|let|class) )/gm, "");
  if (/^\s*(import|export)\b/m.test(body)) throw new Error(`${name}: มี import/export ที่ build ไม่รองรับ`);
  return `const __${name} = (() => {\n${body}\nreturn { ${names.join(", ")} };\n})();`;
}

export function buildBundle() {
  let app = read("public/app.js");
  const imports = [
    ['import { renderMarkdown, escapeHtml as esc } from "./markdown.js";', "const { renderMarkdown, escapeHtml: esc } = __markdown;"],
    ['import * as engine from "./engine.js";', "const engine = __engine;"],
  ];
  for (const [from, to] of imports) {
    if (!app.includes(from)) throw new Error(`app.js: ไม่พบ ${from}`);
    app = app.replace(from, to);
  }
  if (/^\s*(import|export)\b/m.test(app)) throw new Error("app.js: มี import/export ที่ build ไม่รองรับ");
  const js = [wrapModule("engine", read("public/engine.js")), wrapModule("markdown", read("public/markdown.js")), app].join("\n\n");
  if (/<\/script/i.test(js)) throw new Error("โค้ดมี </script ซึ่งจะปิดแท็กก่อนเวลา");
  return js;
}

export function buildData() {
  const index = JSON.parse(read("public/data/knowledge/index.json"));
  return {
    needs: JSON.parse(read("public/data/needs.json")).needs,
    profile: JSON.parse(read("public/data/profile.json")),
    cases: index.files.flatMap((f) => JSON.parse(read(`public/data/knowledge/${f}`)).cases || []),
  };
}

export function buildPage() {
  const html = read("public/index.html");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1];
  if (!body) throw new Error("index.html: ไม่พบ <body>");
  const data = JSON.stringify(buildData()).replace(/</g, "\\u003c");
  return `<title>raburd</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap" />
<style>
${read("public/styles.css")}
</style>
${body.trim()}
<script type="application/json" id="raburd-data">${data}</script>
<script type="module">
${buildBundle()}
</script>
`;
}

function main(argv) {
  const i = argv.indexOf("--out");
  const out = path.resolve(i >= 0 ? argv[i + 1] : path.join(ROOT, "dist", "raburd-artifact.html"));
  const page = buildPage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
  console.log(`เขียนแล้ว: ${out} (${(page.length / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
