import { renderMarkdown, escapeHtml as esc } from "./markdown.js";
import * as engine from "./engine.js";

const $ = (sel, root = document) => root.querySelector(sel);
const SOURCE_LABEL = { "claude-history": "ประวัติ Claude", "site-usage": "คำถามในเว็บ", docs: "คู่มือเว็บ" };
const MAX_HISTORY = 6;

const state = {
  backend: null,
  knowledge: null, // { needs, profile, cases }
  history: [],
  busy: false,
  filter: "all",
};

// ---------------------------------------------------------------- backends

// เซิร์ฟเวอร์ Node (มี Claude / บันทึกการใช้งานจริงลงไฟล์)
function serverBackend(status) {
  return {
    mode: status.mode,
    model: status.model,
    async knowledge() {
      return getJson("api/knowledge");
    },
    async insights() {
      return getJson("api/insights");
    },
    async feedback(payload) {
      const res = await fetch("api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "ส่งผลโหวตไม่สำเร็จ");
    },
    async ask(question, history, on) {
      const res = await fetch("api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `เซิร์ฟเวอร์ตอบกลับ ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) on[event]?.(JSON.parse(data));
        }
      }
    },
  };
}

// โหมด static (เช่น GitHub Pages): คำนวณในเบราว์เซอร์ ผลโหวตเก็บในเครื่องผู้ใช้
async function staticBackend() {
  const [needs, profile, index] = await Promise.all([
    getJson("data/needs.json"),
    getJson("data/profile.json"),
    getJson("data/knowledge/index.json"),
  ]);
  const files = await Promise.all(index.files.map((f) => getJson(`data/knowledge/${f}`)));
  const base = { needs: needs.needs, profile, cases: files.flatMap((f) => f.cases || []) };
  const local = {
    read(key) {
      try {
        return JSON.parse(localStorage.getItem(key) || "[]");
      } catch {
        return [];
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // โหมดส่วนตัว / ปิด storage — ใช้งานต่อได้แค่ไม่จำผลโหวต
      }
    },
  };
  const ASKS = "raburd.asks.v1";
  const FEEDBACK = "raburd.feedback.v1";
  const build = () => {
    const asks = local.read(ASKS);
    const detected = new Map(asks.map((a) => [a.id, a.needs?.[0]]));
    const feedback = local.read(FEEDBACK).map((f) => ({ ...f, detected: detected.get(f.id) }));
    return engine.createKnowledge({ ...base, feedback });
  };
  let kb = build();
  return {
    mode: "static",
    async knowledge() {
      return base;
    },
    async insights() {
      return engine.summarizeUsage(kb, local.read(ASKS), local.read(FEEDBACK));
    },
    async feedback(payload) {
      const list = local.read(FEEDBACK).filter((f) => f.id !== payload.id);
      list.push(payload);
      local.write(FEEDBACK, list);
      kb = build();
    },
    async ask(question, history, on) {
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      const analysis = engine.analyze(question, kb, { context: history.at(-1)?.q || "" });
      on.analysis({
        id,
        mode: "static",
        needs: analysis.needs,
        cases: analysis.cases.map((c) => ({ ...c.case, similarity: c.similarity })),
      });
      on.delta({ text: engine.composeOfflineAnswer(analysis, kb) });
      local.write(ASKS, [...local.read(ASKS), { id, question, needs: analysis.needs.map((n) => n.id), ts: new Date().toISOString() }].slice(-200));
      on.done({ id, mode: "static" });
    },
  };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- helpers

function thaiDate(d) {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return esc(d);
  return date.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
}

const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const needLabel = (id) => state.knowledge?.needs.find((n) => n.id === id)?.label || engine.GENERAL_NEED.label;

// CSP ไม่อนุญาต style แบบ inline ใน HTML จึงตั้งความกว้างของแถบผ่าน CSSOM แทน
function applyWidths(root) {
  for (const el of root.querySelectorAll("[data-w]")) el.style.width = `${Number(el.dataset.w) || 0}%`;
}

function sourceTag(source) {
  return `<span class="src ${esc(source)}">${esc(SOURCE_LABEL[source] || source)}</span>`;
}

function setStatus(mode, model) {
  const el = $("#status");
  el.dataset.mode = mode;
  el.textContent =
    mode === "claude" ? "ตอบด้วย Claude" : mode === "offline" ? "โหมดฐานความรู้" : "โหมด static · ฐานความรู้";
  el.title =
    mode === "claude"
      ? `โมเดล ${model}`
      : "ยังไม่ได้เชื่อม Claude API — ตอบจากเคสการใช้งานจริงในฐานความรู้ และจะไม่เดาเมื่อไม่มีเคสที่ใกล้พอ";
  $("#foot-mode").textContent = mode === "claude" ? `โมเดล: ${model}` : el.title;
}

// ---------------------------------------------------------------- ask view

function renderExamples() {
  // คำถามจริงที่สั้นพอจะกดถามซ้ำได้ (ตัดส่วน "(แนบไฟล์ …)" ออก — เคสที่มีแต่ไฟล์แนบจะถูกข้าม)
  const picks = state.knowledge.cases
    .filter((c) => c.source === "claude-history")
    .map((c) => ({ c, q: c.question.replace(/\s*\(แนบ[^)]*\)\s*$/, "").trim() }))
    .filter(({ q }) => q.length >= 6 && q.length <= 90)
    .slice(0, 5);
  $("#examples").innerHTML = picks
    .map(
      ({ c, q }) =>
        `<button type="button" class="example" data-q="${esc(q)}">${esc(q)}<small>คำถามจริง · ${thaiDate(c.date)}</small></button>`,
    )
    .join("");
}

function readingHtml(a) {
  const top = a.needs[0];
  const needs = a.needs
    .map(
      (n) => `<div class="need">
        <div class="need-top"><span>${esc(n.label)}</span><span>${pct(n.confidence)}</span></div>
        <div class="meter"><i data-w="${Math.max(4, Math.round(n.confidence * 100))}"></i></div>
        <ul>${n.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      </div>`,
    )
    .join("");
  const cases = a.cases.length
    ? a.cases
        .map(
          (c) => `<details class="ref">
            <summary>${sourceTag(c.source)}<span>${esc(engine.truncate(c.question, 90))}</span><span class="sim">ตรง ${pct(c.similarity)}</span></summary>
            <div class="ref-body">
              <p>${thaiDate(c.date)}${c.project ? " · " + esc(c.project) : ""}</p>
              ${c.real_need ? `<p><b>ต้องการจริง:</b> ${esc(c.real_need)}</p>` : ""}
              ${c.lesson ? `<p><b>บทเรียน:</b> ${esc(c.lesson)}</p>` : ""}
            </div>
          </details>`,
        )
        .join("")
    : `<p class="empty">ยังไม่มีคำถามจริงที่ใกล้พอ — ตอบจากความรู้ทั่วไปตามความต้องการที่อ่านได้</p>`;
  return `<summary>
      <span>อ่านความต้องการได้ว่า</span><span class="chip">${esc(top.label)}</span>
      <span class="chip muted">อ้างอิง ${a.cases.length} เคสจริง</span>
    </summary>
    <div class="reading-body">
      <div><h3>ความต้องการ</h3>${needs}</div>
      <div><h3>คำถามจริงที่ใช้อ้างอิง</h3>${cases}</div>
    </div>`;
}

function feedbackUi(turn, id, detected) {
  const box = document.createElement("div");
  box.className = "feedback";
  box.innerHTML = `<span>ตรงกับที่ต้องการไหม?</span>
    <button type="button" data-v="up" aria-pressed="false">ตรง</button>
    <button type="button" data-v="down" aria-pressed="false">ไม่ตรง</button>`;
  turn.append(box);

  const send = async (payload) => {
    try {
      await state.backend.feedback({ id, ...payload });
      box.innerHTML = `<span class="thanks">ขอบคุณ — บันทึกเป็นข้อมูลการใช้งานจริงแล้ว ${
        payload.helpful ? "คำถามนี้จะใช้อ้างอิงคำถามถัดไป" : "ระบบจะใช้แก้การอ่านความต้องการครั้งหน้า"
      }</span>`;
    } catch (err) {
      box.insertAdjacentHTML("beforeend", `<span class="notice">${esc(err.message)}</span>`);
    }
  };

  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-v]");
    if (!btn) return;
    if (btn.dataset.v === "up") return send({ helpful: true, need: detected });
    box.querySelectorAll("button[data-v]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    if ($(".correct", box)) return;
    const needs = state.knowledge.needs.concat([{ id: engine.GENERAL_NEED.id, label: engine.GENERAL_NEED.label }]);
    const form = document.createElement("form");
    form.className = "correct";
    form.innerHTML = `<span>จริง ๆ แล้วต้องการ:</span>
      ${needs
        .map((n) => `<button type="button" data-need="${esc(n.id)}" aria-pressed="false">${esc(n.label)}</button>`)
        .join("")}
      <input name="note" maxlength="500" placeholder="อธิบายเพิ่ม (ไม่บังคับ) เช่น อยากได้แค่คำสั่งรัน" />
      <button type="submit">ส่ง</button>`;
    let chosen = null;
    form.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-need]");
      if (!b) return;
      chosen = b.dataset.need;
      form.querySelectorAll("button[data-need]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      send({ helpful: false, need: chosen, note: form.note.value.trim() });
    });
    box.append(form);
  });
}

async function askQuestion(question) {
  if (state.busy || !question.trim()) return;
  state.busy = true;
  $("#send").disabled = true;
  $("#intro").hidden = true;
  $("#reset").hidden = false;

  const turn = document.createElement("li");
  turn.className = "turn";
  turn.innerHTML = `<div class="q">${esc(question)}</div>`;
  const reading = document.createElement("details");
  reading.className = "reading";
  reading.innerHTML = `<summary><span>กำลังอ่านความต้องการจากคำถามจริงที่คล้ายกัน…</span></summary>`;
  const answer = document.createElement("div");
  answer.className = "answer md loading";
  answer.innerHTML = `<span class="thinking">กำลังคิดคำตอบ…</span>`;
  turn.append(reading, answer);
  $("#thread").append(turn);
  turn.scrollIntoView({ behavior: "smooth", block: "start" });

  let text = "";
  let id = null;
  let detected = null;
  let frame = 0;
  const paint = () => {
    frame = 0;
    answer.innerHTML = renderMarkdown(text);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  try {
    await state.backend.ask(question, state.history, {
      analysis(a) {
        id = a.id;
        detected = a.needs[0]?.id;
        reading.innerHTML = readingHtml(a);
        applyWidths(reading);
      },
      delta({ text: t }) {
        text += t;
        schedule();
      },
      replace({ text: t }) {
        text = t;
        schedule();
      },
      notice({ message }) {
        turn.insertBefore(Object.assign(document.createElement("div"), { className: "notice", textContent: message }), answer);
      },
      sources({ sources }) {
        const box = document.createElement("div");
        box.className = "sources";
        box.innerHTML = `แหล่งข้อมูลจากเว็บ:<ol>${sources
          .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`)
          .join("")}</ol>`;
        answer.after(box);
      },
      done() {},
    });
    if (frame) cancelAnimationFrame(frame);
    paint();
    if (text.trim()) {
      state.history = [...state.history, { q: question, a: text }].slice(-MAX_HISTORY);
    }
    if (id) feedbackUi(turn, id, detected);
  } catch (err) {
    answer.innerHTML = `<p class="notice">${esc(err.message || "เกิดข้อผิดพลาด")}</p>`;
  } finally {
    answer.classList.remove("loading");
    state.busy = false;
    $("#send").disabled = false;
    $("#question").focus();
  }
}

// ---------------------------------------------------------------- insights view

async function renderInsights() {
  let s;
  try {
    s = await state.backend.insights();
  } catch (err) {
    $("#kpis").innerHTML = `<p class="notice">${esc(err.message)}</p>`;
    return;
  }
  const history = (s.cases["claude-history"] || 0);
  $("#kpis").innerHTML = [
    [history, "คำถามจริงจากประวัติ Claude"],
    [s.questions, "คำถามที่ถามในเว็บ"],
    [s.feedback, "ผลโหวตความตรง"],
    [s.helpfulRate == null ? "–" : pct(s.helpfulRate), "ตอบตรงความต้องการ"],
  ]
    .map(([v, l]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`)
    .join("");

  const max = Math.max(1, ...s.needs.map((n) => n.history + n.site));
  $("#need-bars").innerHTML = s.needs
    .sort((a, b) => b.history + b.site - (a.history + a.site))
    .map(
      (n) => `<div class="bar-row">
        <span>${esc(n.label)}</span><span class="count">${n.history} · ${n.site}</span>
        <div class="track" role="img" aria-label="${esc(n.label)}: ประวัติ ${n.history}, เว็บ ${n.site}">
          <i class="h" data-w="${(n.history / max) * 100}"></i><i class="s" data-w="${(n.site / max) * 100}"></i>
        </div>
      </div>`,
    )
    .join("");
  applyWidths($("#need-bars"));

  $("#terms").innerHTML = s.topTerms.length
    ? s.topTerms.map((t) => `<span class="term">${esc(t.term)}<b>${t.count}</b></span>`).join("")
    : `<p class="empty">ยังไม่มีข้อมูล</p>`;

  const recent = s.recent || [];
  $("#recent-card").hidden = !recent.length;
  $("#recent").innerHTML = recent
    .map(
      (r) =>
        `<li>${esc(engine.truncate(r.question, 120))} <span class="chip muted">${esc(needLabel(r.need))}</span>${
          r.helpful === true ? " ✓" : r.helpful === false ? " ✗" : ""
        }</li>`,
    )
    .join("");

  renderProfile();
  renderCases();
}

function renderProfile() {
  const p = state.knowledge.profile || {};
  const list = (xs) => `<ul>${(xs || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  $("#profile").innerHTML = `<div class="profile"><dl>
    <dt>ภาษาที่ใช้ถาม</dt><dd>${esc(p.language || "-")}</dd>
    <dt>งานที่ทำ</dt><dd>${list(p.domains)}</dd>
    <dt>สิ่งที่ชอบในคำตอบ</dt><dd>${list(p.preferences)}</dd>
    <dt>ปัญหาที่เจอซ้ำ</dt><dd>${list(p.recurring_issues)}</dd>
  </dl></div>`;
}

function renderCases() {
  const cases = state.knowledge.cases;
  const sources = ["all", ...new Set(cases.map((c) => c.source))];
  $("#filters").innerHTML = sources
    .map(
      (s) =>
        `<button type="button" data-f="${esc(s)}" aria-pressed="${s === state.filter}">${esc(
          s === "all" ? "ทั้งหมด" : SOURCE_LABEL[s] || s,
        )} <b>${s === "all" ? cases.length : cases.filter((c) => c.source === s).length}</b></button>`,
    )
    .join("");
  const shown = cases.filter((c) => state.filter === "all" || c.source === state.filter);
  $("#cases").innerHTML = shown
    .map(
      (c) => `<details class="case">
        <summary>
          <span class="meta">${sourceTag(c.source)}<span>${thaiDate(c.date)}</span>${c.project ? `<span>· ${esc(c.project)}</span>` : ""}${(c.needs || [])
            .map((n) => `<span class="chip muted">${esc(needLabel(n))}</span>`)
            .join("")}</span>
          <span class="cq">${esc(c.question)}</span>
        </summary>
        <div class="case-body">
          ${c.real_need ? `<h4>ความต้องการจริง</h4><p>${esc(c.real_need)}</p>` : ""}
          ${c.answer ? `<h4>คำตอบที่ได้</h4><div class="md">${renderMarkdown(c.answer)}</div>` : ""}
          ${c.outcome ? `<h4>ผลลัพธ์</h4><p>${esc(c.outcome)}</p>` : ""}
          ${c.lesson ? `<h4>บทเรียน</h4><p>${esc(c.lesson)}</p>` : ""}
        </div>
      </details>`,
    )
    .join("");
}

// ---------------------------------------------------------------- wiring

function showView(name) {
  for (const v of ["ask", "insights"]) {
    $(`#view-${v}`).hidden = v !== name;
    $(`#tab-${v}`).setAttribute("aria-selected", String(v === name));
  }
  if (name === "insights") renderInsights();
  else $("#question").focus();
}

function autosize() {
  const t = $("#question");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + "px";
}

async function init() {
  try {
    const status = await getJson("api/status");
    if (!status.ok) throw new Error();
    state.backend = serverBackend(status);
  } catch {
    try {
      state.backend = await staticBackend();
    } catch (err) {
      setStatus("static");
      $("#status").textContent = "โหลดข้อมูลไม่ได้";
      console.error(err);
      return;
    }
  }
  setStatus(state.backend.mode, state.backend.model);
  state.knowledge = await state.backend.knowledge();
  renderExamples();
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#question").value.trim();
  if (!q || !state.backend) return;
  $("#question").value = "";
  autosize();
  askQuestion(q);
});

$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#question").addEventListener("input", autosize);

$("#examples").addEventListener("click", (e) => {
  const b = e.target.closest(".example");
  if (b && state.backend) askQuestion(b.dataset.q);
});

$("#reset").addEventListener("click", () => {
  if (state.busy) return;
  state.history = [];
  $("#thread").innerHTML = "";
  $("#intro").hidden = false;
  $("#reset").hidden = true;
  $("#question").focus();
});

$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  state.filter = b.dataset.f;
  renderCases();
});

$("#tab-ask").addEventListener("click", () => showView("ask"));
$("#tab-insights").addEventListener("click", () => showView("insights"));

init();
