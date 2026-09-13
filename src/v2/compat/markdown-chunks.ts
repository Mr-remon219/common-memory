// Kept only for existing public callers; no admission, migration or Runtime code calls this helper.
/** @deprecated Legacy standalone chunkMarkdown default, NOT a current import or model limit. */
export const MAX_DOCUMENT_CHUNK_BYTES = 32768;
/** @deprecated Historical v1 file cap, NOT enforced by current imports. */
export const MAX_DOCUMENT_BYTES = 262144;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
export interface MarkdownChunk { headingPath: string[]; text: string }

/**
 * @deprecated Compatibility helper only. New imports use the shared structural ingest path.
 * Split at Markdown structure only. A chunk is a run of whole paragraphs; headings start new units,
 * fenced code is never split, blank lines inside fences are not boundaries. Sections stay whole when
 * they fit. `headingPath` is the ancestor heading stack at the chunk start, so a chunk that begins
 * under "## Examples" still says so. One unit larger than the budget rejects the whole import.
 */
export function chunkMarkdown(text: string, budget = MAX_DOCUMENT_CHUNK_BYTES): MarkdownChunk[] {
  if (Buffer.byteLength(text) <= budget) return [{ headingPath: [], text }];
  interface Unit { headingPath: string[]; text: string; heading: boolean }
  const units: Unit[] = [];
  const stack: { level: number; title: string }[] = [];
  let fence: { char: string; size: number } | undefined;
  let current: Unit | undefined;
  const close = () => { if (current && current.text) units.push(current); current = undefined; };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const plain = line.replace(/\n$/, '');
    // A backtick fence cannot open with a backtick in its info string (CommonMark): "```js``` inline" is text.
    const marker = FENCE.exec(plain);
    if (marker && !(fence === undefined && marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      const token = marker[1]!;
      if (!fence) { fence = { char: token[0]!, size: token.length }; current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line; continue; }
      current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line;
      if (token[0] === fence.char && token.length >= fence.size && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence) { current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line; continue; }
    const heading = HEADING.exec(plain);
    if (heading) {
      close();
      const level = heading[1]!.length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      current = { headingPath: stack.map(h => h.title), text: line, heading: true };
      // An optional closing sequence is only a closing sequence when preceded by whitespace ("# C#" keeps "C#").
      stack.push({ level, title: (heading[2] ?? '').replace(/[ \t]+#+$/, '').trim() });
      continue;
    }
    // Blank lines end a paragraph but are kept verbatim, including leading and consecutive ones.
    if (!plain.trim()) { current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line; close(); continue; }
    current ??= { headingPath: stack.map(h => h.title), text: '', heading: false };
    current.text += line;
  }
  close();
  for (const unit of units) if (Buffer.byteLength(unit.text) > budget) throw new Error('IMPORT_CHUNK_TOO_LARGE');
  // Group units into sections (a heading plus everything up to the next heading), then pack:
  // whole sections when they fit, paragraph units otherwise.
  const sections: Unit[][] = [];
  for (const unit of units) { if (unit.heading || !sections.length) sections.push([unit]); else sections.at(-1)!.push(unit); }
  const chunks: MarkdownChunk[] = [];
  let open: MarkdownChunk | undefined; let openBytes = 0;
  const flush = () => { if (open) chunks.push(open); open = undefined; openBytes = 0; };
  const add = (unit: Unit) => {
    const bytes = Buffer.byteLength(unit.text);
    if (open && openBytes + bytes > budget) flush();
    if (!open) open = { headingPath: unit.headingPath, text: '' };
    open.text += unit.text; openBytes += bytes;
  };
  for (const section of sections) {
    const bytes = section.reduce((n, unit) => n + Buffer.byteLength(unit.text), 0);
    if (bytes <= budget) { if (open && openBytes + bytes > budget) flush(); for (const unit of section) add(unit); }
    else { flush(); for (const unit of section) add(unit); flush(); }
  }
  flush();
  return chunks;
}

