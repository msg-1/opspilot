export interface Chunk {
  index: number;
  heading: string | null;
  content: string;
  tokenEstimate: number;
}

const MAX_CHARS = 1200;
const OVERLAP_CHARS = 150;

/**
 * Markdown-aware chunking: split on headings so each chunk stays inside one section, then
 * pack paragraphs up to MAX_CHARS with a small overlap so sentences cut at a boundary remain
 * retrievable. The heading trail is stored with the chunk and embedded alongside it.
 */
export function chunkMarkdown(title: string, content: string): Chunk[] {
  const sections: { heading: string | null; body: string }[] = [];
  const trail: string[] = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  let inFence = false;
  const flush = () => {
    const body = current.lines.join('\n').trim();
    if (body) sections.push({ heading: current.heading, body });
  };
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    const match = !inFence ? /^(#{1,4})\s+(.+?)\s*#*$/.exec(line) : null;
    if (match) {
      flush();
      const level = match[1]!.length;
      trail.length = level - 1;
      trail[level - 1] = match[2]!;
      current = { heading: trail.filter(Boolean).join(' › '), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const chunks: Chunk[] = [];
  const push = (heading: string | null, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    chunks.push({ index: chunks.length, heading, content: trimmed, tokenEstimate: Math.ceil(trimmed.length / 4) });
  };
  for (const section of sections) {
    const paragraphs = section.body.split(/\n{2,}/).flatMap((p) => splitLong(p));
    let buffer = '';
    for (const p of paragraphs) {
      if (buffer && buffer.length + p.length + 2 > MAX_CHARS) {
        push(section.heading, buffer);
        buffer = `${buffer.slice(-OVERLAP_CHARS)}\n\n${p}`;
      } else {
        buffer = buffer ? `${buffer}\n\n${p}` : p;
      }
    }
    push(section.heading, buffer);
  }
  if (!chunks.length && title.trim()) push(null, title);
  return chunks;
}

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHARS) return [paragraph];
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf('. ', MAX_CHARS);
    if (cut < MAX_CHARS / 2) cut = rest.lastIndexOf('\n', MAX_CHARS);
    if (cut < MAX_CHARS / 2) cut = rest.lastIndexOf(' ', MAX_CHARS);
    if (cut < MAX_CHARS / 2) cut = MAX_CHARS;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/** Text that is actually embedded for a chunk: title and section give the vector its context. */
export const embeddingText = (title: string, chunk: Pick<Chunk, 'heading' | 'content'>) =>
  [title, chunk.heading, chunk.content].filter(Boolean).join('\n');
