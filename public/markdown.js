// Markdown → HTML แบบปลอดภัย: escape ทุกอย่างก่อน แล้วค่อยแปลงเฉพาะไวยากรณ์ที่รู้จัก
// รองรับ: หัวข้อ, ย่อหน้า, ตัวหนา/เอียง, inline code, code block, ลิสต์, ตาราง, quote, เส้นคั่น, ลิงก์ http(s)

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

function inline(text) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[เคส: ([^\]]+)\]/g, '<span class="cite">เคส: $1</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i += 1; // ข้าม ``` ปิด (หรือจบไฟล์ระหว่าง stream)
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
      out.push(`<pre${lang}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 1, 5);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    const list = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[2]) === ordered) {
          items.push({ text: m[3], sub: [] });
          i += 1;
        } else if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].sub.push(lines[i].trim());
          i += 1;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      const start = ordered ? Number.parseInt(list[1], 10) : 1;
      const attr = ordered && start !== 1 ? ` start="${start}"` : "";
      out.push(
        `<${tag}${attr}>${items
          .map((it) => `<li>${inline(it.text)}${it.sub.length ? renderMarkdown(it.sub.join("\n")) : ""}</li>`)
          .join("")}</${tag}>`,
      );
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
