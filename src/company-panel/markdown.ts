/**
 * Minimal markdown → block model for the findings memory file. Findings are
 * summaries of fetched web pages, i.e. untrusted text: this parser produces
 * plain data that React renders as text nodes. No HTML is ever interpreted and
 * links stay visible text (no navigation from the panel).
 *
 * Supported: ATX headings, `-`/`*`/`+`/`1.` list items (nesting by indent),
 * fenced code, paragraphs, and inline `code` / **strong**.
 */

export type Inline = { kind: "text" | "code" | "strong"; text: string };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "item"; depth: number; inline: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "paragraph"; inline: Inline[] };

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: "code", text: m[1] } : { kind: "strong", text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2].trim()) });
      continue;
    }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const indent = item[1].replace(/\t/g, "  ").length;
      blocks.push({ kind: "item", depth: Math.min(Math.floor(indent / 2), 6), inline: parseInline(item[2]) });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
