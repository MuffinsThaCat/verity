/** What an evidence URI points at, in words a reader understands. Pure string work, safe to use anywhere. */
export interface SourceInfo {
  host: string;
  /** "Pluto" for a Wikipedia revision, otherwise the host. */
  title: string;
  /** Revision id when the URI pins one. */
  rev: number | null;
  /** Short label for a reference list: "Pluto (Wikipedia, revision 1234)". */
  label: string;
  /** A page a human can open; for Wikipedia this drops `action=raw` so the browser renders the article. */
  readable: string | null;
  mock: boolean;
}

/**
 * `mockCorpus` says the run really is reading the built-in offline corpus. Only then is `mock-corpus.invalid` taken for it:
 * on a real network anyone can post an address on that host, and it must not be shown as a harmless test fixture.
 */
export function describeSource(uri: string, o: { mockCorpus?: boolean } = {}): SourceInfo {
  let u: URL;
  try { u = new URL(uri); } catch { return { host: uri, title: uri, rev: null, label: uri, readable: null, mock: false }; }
  const mock = o.mockCorpus === true && u.host === "mock-corpus.invalid";
  if (mock) {
    const title = decodeURIComponent(u.pathname.split("/").pop() ?? "") || u.host;
    return { host: u.host, title, rev: null, label: `${title} (offline test corpus)`, readable: null, mock: true };
  }
  const wiki = /(^|\.)wikipedia\.org$/.test(u.host);
  const title = u.searchParams.get("title")?.replace(/_/g, " ");
  const oldid = u.searchParams.get("oldid");
  if (wiki && title) {
    const rev = oldid && /^\d+$/.test(oldid) ? Number(oldid) : null;
    const readable = new URL(u.toString());
    readable.searchParams.delete("action");
    return { host: u.host, title, rev, label: `${title} (Wikipedia${rev ? `, revision ${rev}` : ""})`, readable: /^https?:$/.test(readable.protocol) ? readable.toString() : null, mock: false };
  }
  return { host: u.host, title: u.host, rev: null, label: u.host, readable: /^https?:$/.test(u.protocol) ? u.toString() : null, mock: false };
}

/** The first path segment of a topic is the article; anything after it names a section of that article. */
export const articleOf = (topic: string) => topic.split("/")[0]!;
export const sectionOf = (topic: string) => topic.split("/").slice(1).join("/");

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** "mount-everest" → "Mount Everest". */
export const prettyTopic = (slug: string) => slug.split(/[-_:]+/).filter(Boolean).map(cap).join(" ");
