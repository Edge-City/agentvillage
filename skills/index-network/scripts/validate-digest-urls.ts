#!/usr/bin/env bun
/**
 * Deterministic URL guard for the morning digest.
 *
 * The digest body is composed by an LLM. When an opportunity card lacks a real
 * `acceptUrl` (non-actionable status/role, or a swallowed mint error) the model
 * is prone to fabricating one from the field name — e.g. `index.network/accept/901`,
 * a path that does not exist and 404s. Every prompt-side guardrail against this
 * is natural language the model can ignore; this script is the enforcement layer.
 *
 * The only Index URLs an opportunity card legitimately carries open the Index app:
 * a person (`<base>/u/<uuid>`), a signal (`<base>/i/<id>`), and an opportunity
 * (`<base>/o/<id>`). Connect redirects (`/c/<code>`) are not opportunity links.
 * Any other markdown link is demoted to its plain-text label and reported, except
 * a negotiation trace (`/chat/<uuid>`) or a village portal event link. The Index
 * check is host-agnostic so dev / railway / prod bases all pass.
 *
 * Usage (from the digest agent's workdir, i.e. $HERMES_HOME):
 *   bun skills/index-network/scripts/validate-digest-urls.ts /tmp/digest-draft.md
 *   bun skills/index-network/scripts/validate-digest-urls.ts --strip-digest-metadata memory/digest-outgoing.md
 *   bun skills/index-network/scripts/validate-digest-urls.ts --opportunity-ids memory/digest-outgoing.md
 * Reads the file (or stdin when no path is given), writes the sanitized body to
 * stdout, and logs any stripped URLs to stderr. Exit code is always 0 so the body
 * still ships — minus the fabricated links. Digest metadata comments are preserved
 * by default so the editable Kanban draft can carry delivery bookkeeping; pass
 * `--strip-digest-metadata` before final delivery.
 */

/** Person link: `/u/<uuid>`, optional trailing slash. */
const PROFILE_PATH = /^\/u\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/;
/** Opportunity link: `/o/<id>`, optional trailing slash. */
const OPPORTUNITY_PATH = /^\/o\/[A-Za-z0-9_-]+\/?$/;
/** Signal link: `/i/<id>`, optional trailing slash. */
const INTENT_PATH = /^\/i\/[A-Za-z0-9_-]+\/?$/;
/** Negotiation-trace link: `/chat/<conversationId-uuid>`, optional trailing slash. */
const CHAT_PATH = /^\/chat\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/;
/** Event id path segment appended to the village portal events base, optional trailing slash. */
const EVENT_ID_SEGMENT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/;

/**
 * The village portal's events base URL (e.g. `https://<host>/portal/<popup-slug>/events`)
 * from `AV_PORTAL_URL`, without a trailing slash. `null` when unset: no event links
 * are built or allowed until the deployment configures the current popup's portal.
 */
export function portalEventsBaseUrl(): string | null {
  const raw = process.env.AV_PORTAL_URL?.trim().replace(/\/+$/, "");
  return raw ? raw : null;
}

/**
 * A markdown inline link: `[label](url)`. Label runs to the first `]`; url to the next `)`.
 *
 * Legitimate Index URLs contain no `(`/`)`/`]`, so this never
 * truncates a real link.
 */
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
const AUTOLINK = /<((?:https?:\/\/)[^>\s]+)>/g;
const BARE_URL = /https?:\/\/[^\s<>)]+/g;

/**
 * Hidden marker that ties an editable digest fragment to the opportunity it represents.
 * The `id=` prefix is canonical (see prepare.md) but optional here: the LLM composer
 * occasionally drops it, and an unmatched marker would both leak into delivered prose
 * and silently lose the opportunity from extraction. The optional group is greedy, so
 * `id=UUID` still captures just `UUID` and a bare `UUID` is captured verbatim.
 */
const DIGEST_OPPORTUNITY_MARKER = /<!--\s*digest-opportunity:(?:id=)?([^\s>]+)\s*-->/g;
/** Hidden marker that ties a digest question fragment to the question it represents. `id=` optional — see above. */
const DIGEST_QUESTION_MARKER = /<!--\s*digest-question:(?:id=)?([^\s>]+)\s*-->/g;
/** Any internal digest metadata marker (opportunity or question) — the strip set. `id=` optional — see above. */
const DIGEST_METADATA_MARKER = /<!--\s*digest-(?:opportunity|question):(?:id=)?[^\s>]+\s*-->/g;

export interface SanitizeDigestOptions {
  /** Strip internal digest metadata comments before user-facing delivery. */
  stripDigestMetadata?: boolean;
}

/**
 * Whether `url` is a legitimate Index link (person, signal, opportunity) or a
 * calendar event link under the configured village portal (`AV_PORTAL_URL`).
 * Index links are host-agnostic by path shape so dev/prod bases both pass.
 * Event links are pinned to the configured portal origin + events path.
 * A non-absolute or unparseable URL is never allowed.
 */
export function isAllowedDigestUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    PROFILE_PATH.test(parsed.pathname)
    || OPPORTUNITY_PATH.test(parsed.pathname)
    || INTENT_PATH.test(parsed.pathname)
    || CHAT_PATH.test(parsed.pathname)
  ) {
    return true;
  }
  const base = portalEventsBaseUrl();
  if (!base) return false;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return false;
  }
  const basePath = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
  return parsed.origin === baseUrl.origin
    && parsed.pathname.startsWith(basePath)
    && EVENT_ID_SEGMENT.test(parsed.pathname.slice(basePath.length));
}

/**
 * Strip every markdown link whose URL is not an allowed digest action link,
 * leaving the link's label text in place. Allowed links pass through verbatim.
 *
 * @param markdown - the composed digest body
 * @returns the sanitized body and the list of URLs that were stripped (in order)
 */
/**
 * Extract opportunity ids from digest metadata markers that remain in the edited body.
 *
 * @param markdown - the editable digest body
 * @returns unique opportunity ids in first-seen order
 */
export function extractDigestOpportunityIds(markdown: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const match of markdown.matchAll(DIGEST_OPPORTUNITY_MARKER)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * Extract question ids from digest question markers that remain in the edited body.
 *
 * @param markdown - the editable digest body
 * @returns unique question ids in first-seen order
 */
export function extractDigestQuestionIds(markdown: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const match of markdown.matchAll(DIGEST_QUESTION_MARKER)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * Remove internal digest metadata comments from user-facing output.
 *
 * @param markdown - the digest body
 * @returns markdown without digest opportunity/question markers
 */
export function stripDigestMetadata(markdown: string): string {
  return markdown.replace(DIGEST_METADATA_MARKER, "");
}

export function sanitizeDigestUrls(
  markdown: string,
  options: SanitizeDigestOptions = {},
): { output: string; stripped: string[] } {
  const stripped: string[] = [];
  const preservedLinks: string[] = [];
  const preserve = (value: string): string => {
    const token = `\u0000DIGEST_URL_${preservedLinks.length}\u0000`;
    preservedLinks.push(value);
    return token;
  };

  const sanitizedMarkdownLinks = markdown.replace(MARKDOWN_LINK, (match, label: string, url: string) => {
    if (isAllowedDigestUrl(url)) return match;
    stripped.push(url);
    return label;
  });

  const protectedMarkdownLinks = sanitizedMarkdownLinks.replace(MARKDOWN_LINK, (match, _label: string, url: string) => {
    if (isAllowedDigestUrl(url)) return preserve(match);
    return match;
  });

  const sanitizedAutolinks = protectedMarkdownLinks.replace(AUTOLINK, (match, url: string) => {
    if (isAllowedDigestUrl(url)) return preserve(match);
    stripped.push(url);
    return "";
  });

  const sanitizedBareUrls = sanitizedAutolinks.replace(BARE_URL, (match: string) => {
    const trailing = match.match(/[.,!?;:]+$/)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (isAllowedDigestUrl(url)) return match;
    stripped.push(url);
    return trailing;
  });

  const restored = sanitizedBareUrls.replace(/\u0000DIGEST_URL_(\d+)\u0000/g, (_match, idx: string) => preservedLinks[Number(idx)] ?? "");
  const output = options.stripDigestMetadata ? stripDigestMetadata(restored) : restored;
  return { output, stripped };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stripMetadata = args.includes("--strip-digest-metadata");
  const outputOpportunityIds = args.includes("--opportunity-ids");
  const path = args.find((arg) => !arg.startsWith("--"));
  const input = path
    ? await Bun.file(path).text()
    : await Bun.readableStreamToText(Bun.stdin.stream());

  if (outputOpportunityIds) {
    process.stdout.write(`${JSON.stringify(extractDigestOpportunityIds(input))}\n`);
    return;
  }

  const { output, stripped } = sanitizeDigestUrls(input, { stripDigestMetadata: stripMetadata });

  if (stripped.length > 0) {
    console.error(
      `[validate-digest-urls] stripped ${stripped.length} fabricated/unrecognized URL(s):`,
    );
    for (const url of stripped) console.error(`  - ${url || "(empty)"}`);
  }

  process.stdout.write(output);
}

if (import.meta.main) {
  await main();
}
