/**
 * Mini-apps manifest v2: the JSON Schema and the ONE validator (MINIAPPS-PLATFORM-v2-design.md §1.1, §1.3,
 * §8 Phase 0 item 1). One JSON document per app is its whole definition; this module decides whether a
 * document is one, and derives from it the v1 catalog entry the cp serves today (byte for byte), so the
 * six reviewed constants can be served from six manifests.
 *
 * This file is byte-identical in three repos (each pins its sha256 twice: a pins file and its test):
 *   agentvillage-controlplane  control-plane/src/mini-apps-manifests.js
 *   agentvillage-app           src/lib/server/mini-apps/manifests/mini-apps-manifests.cjs
 *   agentvillage (overlay)     scripts/mini-apps-manifests.cjs
 * Change all three together. CommonJS, no dependencies and no I/O: a caller reads the files, this decides.
 * The schema is interpreted here (the subset of JSON Schema 2020-12 it uses: type, const, enum, pattern,
 * lengths, bounds, items, properties, required, additionalProperties, propertyNames, anyOf, $ref), so the
 * same bytes give the same answer in Node, Bun and the app; the cp and app tests check that ajv 2020
 * (strict) gives the same answer as this interpreter on every manifest they try.
 *
 * Phase 0 (dark): nothing reads a manifest at runtime unless the cp's MINI_APPS_MANIFESTS=1 is set. The
 * `legacy` block carries what today's exact-equality v1 entry needs and v2 does not model (provenance,
 * the per-box person entry, the op prefixes that predate "first segment = id"); it retires with the
 * signed projection (design §1.2, §2.3, Phase 2). Only the six first-party ids may carry it, and only
 * as FIRST_PARTY below grants: a manifest's own content never widens what it may claim.
 */
'use strict';

const MANIFEST_VERSION = 2;
const CODE = 'mini_apps_manifest_invalid';
const V1_CODE = 'mini_apps_manifest_v1_unrepresentable';
const MAX_ERRORS = 32;
// The cp's app id rule (cp-events.js CLAIM_APP_ID; the app's sections.ts APP_ID): one rule everywhere.
const APP_ID = '^[a-z0-9][a-z0-9-]{0,39}$';
// Two to four dot-separated segments; `_` is allowed because today's names use it (zzz.list_rooms).
const OPERATION_NAME = '^[a-z0-9][a-z0-9_-]*(\\.[a-z0-9][a-z0-9_-]*){1,3}$';
// Digits only, no pre-release (RA36 M2, lead L19834 (4)): the box's generic-entry rule is MAJOR.MINOR.PATCH, so a
// pre-release version the cp let through was refused on the box; the cp now fails it where the author sees it.
const SEMVER = '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$';
// The same UUID forms as the cp's CREDIT_UUID and the app's z.uuid(): RFC version/variant, nil and max.
const UUID = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$';
const HTTPS_URL = '^https://[^\\s]{1,2040}$';
const TRIMMED = '^\\S(.*\\S)?$';
// The ops the cp appends itself; a manifest never names them (design §1.1 operations[].name).
const RELAY_OPERATION = 'mini-app.read';
const CONTEXT_OPERATIONS = Object.freeze(['mini-app.context.read', 'mini-app.context.write']);
const PROVENANCE = 'first-party-reviewed-external';
// The six first-party apps, pinned HERE, never by a manifest field (security review "authorization-
// reserved-namespace"): what only each may carry. `internal`: service.kind "internal" (core handlers in
// app code, design §2.1: rolodex.*, skylight.*, gold-stars.* "are first-party"); `none`: service.kind
// "none" (no service at all: a context-only app, whose page in the app writes the resident's own context
// namespace; served as Dizko's `mini-app.read` with no mcp block; lead ruling CLAIMS L16434, Mosaic alone,
// cp#334's MOSAIC and MOSAIC_CONTEXT); `prefixes`: the op
// namespaces it owns beyond its id; `provenance`, `personOnly`: its exact Phase 0 legacy block;
// `secretRef`: the one app-server env var outside MINI_APP_<ID>_ it may name (the token the app sends
// today, forkicks-client.ts); `staff`: it may say `"staff": true` (fold 2: kept installed for every agent,
// never removable, so it widens exposure; cp#322 and ov#411 mark Gold Stars alone). Any other manifest's ops
// sit under its own id, it is never `internal` or staff, it carries no `legacy` block, and its secretRef is
// MINI_APP_<ID>_<NAME> (review-b S1, design §2).
const FIRST_PARTY = deepFreeze({
  'gold-stars': { internal: true, prefixes: ['rolodex', 'skylight'], personOnly: true, staff: true },
  dizko: {},
  zzzbot: { provenance: PROVENANCE, prefixes: ['zzz'] },
  slopfolio: { provenance: PROVENANCE },
  forkicks: { secretRef: 'FORKICKS_AV_TOKEN' },
  mosaic: { none: true },
});
// Ids no manifest may take: the platform's own op namespaces and the overlay's baseline (non-app) skill
// names (an app's skill is named for its id, so such an id would shadow a shipped skill on the box), and
// any id in a platform family. The first-party prefixes above are reserved too (only their owner uses them).
const RESERVED_IDS = Object.freeze(['mini-app', 'mini-apps', 'rolodex', 'skylight', 'zzz', 'village', 'marketplace', 'approval',
  'agent-commons', 'agent-plaza', 'agent-profile', 'edgeos', 'hooks', 'index-network', 'recall', 'record-intention', 'simocracy',
  'token-usage-audit', 'moralmod', 'odin', 'index']);
const RESERVED_ID_FAMILY = /^(?:av|agentvillage|agent-village|mini-app|mini-apps|staff|admin|edge|edgecity|edge-city|core|cp|platform|system)(?:-|$)/;
const reservedId = id => RESERVED_IDS.includes(id) || RESERVED_ID_FAMILY.test(id) ||
  Object.entries(FIRST_PARTY).some(([owner, grant]) => owner !== id && (grant.prefixes || []).includes(id));
const DEFAULTS = Object.freeze({ maxRequestBytes: 4096, maxResponseBytes: 262144, timeoutMs: 25000, framing: 'data' });
// The generic approval card (Phase 1 item 6, CARD-COMMON contract 1): a needs-card op's `approval.card` names
// the four strings of the minimal card by dotted path under the prepare op's preview (and `bind`, the request
// to preview equalities the app enforces at prepare). A path is 1..8 segments; a segment is an identifier
// (no array index: a card string is one value, never a list). The preview's platform keys (CARD_PLATFORM_KEYS:
// the app, the needs-card op and the draft, bound by the approval key itself) are neither shown nor bound.
const CARD_FIELDS = Object.freeze(['item', 'total', 'when', 'shared']);
const CARD_PATH = '^[A-Za-z_][A-Za-z0-9_]{0,63}(\\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$';
// One segment of a card path (CARD_PATH's segment rule): a card prepare op's input property name must be one.
const CARD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CARD_PLATFORM_KEYS = Object.freeze(['appId', 'draftId', 'operation']);

const text = (max, extra = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra });
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Agent Village mini-app manifest v2',
  description: 'One reviewed mini-app (MINIAPPS-PLATFORM-v2-design.md section 1.1). Closed: a key not named here is refused.',
  type: 'object',
  required: ['manifest', 'id', 'name', 'version', 'description', 'homepage', 'visibility', 'permissions', 'service', 'operations', 'skills'],
  additionalProperties: false,
  properties: {
    manifest: { const: MANIFEST_VERSION },
    id: { type: 'string', pattern: APP_ID },
    name: text(160),
    version: { type: 'string', maxLength: 80, pattern: SEMVER },
    description: text(2000),
    homepage: { type: 'string', pattern: HTTPS_URL },
    owner: {
      type: 'object', required: ['github'], additionalProperties: false,
      properties: {
        github: { anyOf: [{ $ref: '#/$defs/login' }, { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { $ref: '#/$defs/login' } }] },
        org: text(120, { pattern: TRIMMED }),
      },
    },
    credit: {
      type: 'object', required: ['role', 'attendeeId', 'name'], additionalProperties: false,
      properties: {
        role: { enum: ['app', 'product'] },
        attendeeId: { type: 'string', pattern: UUID },
        name: text(120, { pattern: TRIMMED }),
      },
    },
    visibility: { enum: ['sandbox', 'admins', 'everyone'] },
    staff: { description: 'Comes with every agent: kept installed, never removable (cp catalog staff: true). Absent means false.', type: 'boolean' },
    listed: { description: 'false keeps a reviewed app off every install and discovery surface. Absent means true.', type: 'boolean' },
    permissions: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object', required: ['kind', 'label', 'description'], additionalProperties: false,
        properties: { kind: { enum: ['read', 'action'] }, label: text(160), description: { type: 'string', maxLength: 1000 } },
      },
    },
    service: {
      type: 'object', required: ['kind'], additionalProperties: false,
      properties: {
        kind: { enum: ['mcp', 'https-json', 'internal', 'none'] },
        baseUrl: { type: 'string', pattern: HTTPS_URL },
        auth: {
          type: 'object', required: ['mode'], additionalProperties: false,
          properties: {
            mode: { enum: ['none', 'oauth', 'app-token'] },
            oauth: {
              type: 'object', required: ['resource', 'scopes', 'discovery'], additionalProperties: false,
              properties: {
                resource: { type: 'string', pattern: HTTPS_URL },
                scopes: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_:.-]{1,64}$' } },
                discovery: { type: 'string', pattern: HTTPS_URL },
              },
            },
            secretRef: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
          },
        },
      },
    },
    operations: {
      description: 'At least one, except for service kind none (a context-only app), which has none: the validator checks it, by kind.',
      type: 'array', maxItems: 32, items: { $ref: '#/$defs/operation' },
    },
    data: {
      type: 'object', additionalProperties: false,
      properties: {
        context: {
          type: 'object', required: ['maxEntries'], additionalProperties: false,
          properties: {
            maxEntries: { type: 'integer', minimum: 1, maximum: 64 },
            ceiling: { enum: ['private', 'village', 'public'] },
          },
        },
      },
    },
    skills: {
      type: 'array', minItems: 1, maxItems: 1,
      items: {
        type: 'object', required: ['name', 'version', 'sha256', 'path'], additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
          version: { type: 'string', maxLength: 80, pattern: SEMVER },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          path: { type: 'string', maxLength: 200, pattern: '^skills/[a-z][a-z0-9-]{0,63}/SKILL\\.md$' },
        },
      },
    },
    events: {
      type: 'object', maxProperties: 16,
      propertyNames: { type: 'string', maxLength: 120, pattern: '^miniapp\\.[a-z0-9][a-z0-9-]{0,39}\\.[a-z][a-z0-9_.-]{0,63}@[1-9][0-9]{0,3}$' },
      additionalProperties: {
        type: 'object', minProperties: 1, maxProperties: 16,
        propertyNames: { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,63}$' },
        additionalProperties: { enum: ['string', 'integer', 'boolean'] },
      },
    },
    legacy: {
      description: 'Phase 0 only: what the v1 entry needs and v2 does not model. Retires with the signed projection.',
      type: 'object', additionalProperties: false,
      properties: {
        provenance: { const: PROVENANCE },
        prefixes: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' } },
        personOnly: {
          type: 'object', required: ['operations', 'permissions'], additionalProperties: false,
          properties: {
            operations: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', pattern: OPERATION_NAME } },
            permissions: { type: 'array', maxItems: 32, uniqueItems: true, items: text(160) },
          },
        },
      },
    },
  },
  $defs: {
    login: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$' },
    operation: {
      type: 'object', required: ['name', 'class'], additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 100, pattern: OPERATION_NAME },
        class: { enum: ['read', 'write', 'prepare', 'needs-card'] },
        target: {
          anyOf: [
            { type: 'object', required: ['tool'], additionalProperties: false, properties: { tool: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' } } },
            {
              type: 'object', required: ['method', 'path'], additionalProperties: false,
              properties: { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/[A-Za-z0-9/_.-]{0,199}$' } },
            },
          ],
        },
        input: { type: 'object' },
        maxRequestBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        maxResponseBytes: { type: 'integer', minimum: 1, maximum: 26214400 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
        framing: { enum: ['data', 'media'] },
        returns: {
          type: 'object', required: ['draftIdPath', 'previewPath', 'previewMaxBytes', 'previewTtlSeconds'], additionalProperties: false,
          properties: {
            draftIdPath: { $ref: '#/$defs/jsonPath' },
            previewPath: { $ref: '#/$defs/jsonPath' },
            previewMaxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
            previewTtlSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
          },
        },
        approval: {
          type: 'object', required: ['prepare'], additionalProperties: false,
          properties: {
            prepare: { type: 'string', maxLength: 100, pattern: OPERATION_NAME },
            summary: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 500 } },
            summaryMaxBytes: { type: 'integer', minimum: 1, maximum: 3000 },
            card: {
              description: 'The generic approval card: four dotted paths under the prepare op preview, each naming a string, and bind, the (request path, preview path) equalities the app enforces at prepare. Every other preview key must be bound.',
              type: 'object', required: [...CARD_FIELDS, 'bind'], additionalProperties: false,
              properties: {
                ...Object.fromEntries(CARD_FIELDS.map(field => [field, { $ref: '#/$defs/cardPath' }])),
                bind: { type: 'array', maxItems: 32, items: { type: 'array', minItems: 2, maxItems: 2, items: { $ref: '#/$defs/cardPath' } } },
              },
            },
          },
        },
      },
    },
    jsonPath: { type: 'string', maxLength: 200, pattern: '^\\$(\\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,8}$' },
    cardPath: { type: 'string', maxLength: 200, pattern: CARD_PATH },
  },
};

// The catalog index (mini-apps/catalog.json): which manifests are published, in the order served.
const INDEX_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', required: ['catalog', 'apps'], additionalProperties: false,
  properties: {
    catalog: { const: MANIFEST_VERSION },
    apps: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: APP_ID } },
  },
};

// ---- The schema interpreter ---------------------------------------------------------------------
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const codePoints = value => { let n = 0; for (const _ of value) n++; return n; };
const regexes = new Map();
const regex = source => {
  if (!regexes.has(source)) regexes.set(source, new RegExp(source, 'u'));
  return regexes.get(source);
};
const TYPES = {
  object: isObject, array: Array.isArray, string: v => typeof v === 'string', boolean: v => typeof v === 'boolean',
  integer: v => Number.isInteger(v), number: v => typeof v === 'number' && Number.isFinite(v),
};
function resolve(root, ref) {
  const m = /^#\/\$defs\/([A-Za-z]+)$/.exec(ref);
  if (!m || !own(root.$defs, m[1])) throw new Error('mini_apps_schema_ref_unknown');
  return root.$defs[m[1]];
}
function walk(schema, value, at, errors, root) {
  if (errors.length >= MAX_ERRORS) return;
  const fail = (reason, where = at) => { if (errors.length < MAX_ERRORS) errors.push({ path: where || '/', reason }); };
  if (own(schema, '$ref')) return walk(resolve(root, schema.$ref), value, at, errors, root);
  if (own(schema, 'anyOf')) {
    if (!schema.anyOf.some(option => { const e = []; walk(option, value, at, e, root); return e.length === 0; })) fail('anyOf');
    return;
  }
  if (own(schema, 'const') && value !== schema.const) return fail('const');
  if (own(schema, 'enum') && !schema.enum.includes(value)) return fail('enum');
  if (own(schema, 'type') && !TYPES[schema.type](value)) return fail('type');
  if (typeof value === 'string') {
    const n = codePoints(value);
    if (own(schema, 'minLength') && n < schema.minLength) fail('minLength');
    if (own(schema, 'maxLength') && n > schema.maxLength) fail('maxLength');
    if (own(schema, 'pattern') && !regex(schema.pattern).test(value)) fail('pattern');
  }
  if (typeof value === 'number') {
    if (own(schema, 'minimum') && value < schema.minimum) fail('minimum');
    if (own(schema, 'maximum') && value > schema.maximum) fail('maximum');
  }
  if (Array.isArray(value)) {
    if (own(schema, 'minItems') && value.length < schema.minItems) fail('minItems');
    if (own(schema, 'maxItems') && value.length > schema.maxItems) return fail('maxItems');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('uniqueItems');
    if (own(schema, 'items')) value.forEach((item, i) => walk(schema.items, item, `${at}/${i}`, errors, root));
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (own(schema, 'minProperties') && keys.length < schema.minProperties) fail('minProperties');
    if (own(schema, 'maxProperties') && keys.length > schema.maxProperties) return fail('maxProperties');
    for (const key of schema.required || []) if (!own(value, key)) fail(`required:${key}`);
    for (const key of keys) {
      const where = `${at}/${key}`;
      if (own(schema, 'propertyNames')) walk(schema.propertyNames, key, where, errors, root);
      if (schema.properties && own(schema.properties, key)) walk(schema.properties[key], value[key], where, errors, root);
      else if (schema.additionalProperties === false) fail('additionalProperties', where);
      else if (isObject(schema.additionalProperties)) walk(schema.additionalProperties, value[key], where, errors, root);
    }
  }
}
/** The schema phase alone: the errors JSON Schema itself gives ([] when the value is schema-valid). */
function checkSchema(value, schema = SCHEMA) {
  const errors = [];
  walk(schema, value, '', errors, schema);
  return errors;
}

// ---- The checks beyond the schema (design §1.1 field rules, §1.3) ---------------------------------
// The secret shapes the PR-review bot also scans (§6.1), and any http: URL or data: URI, in any key or string.
// Every pattern is linear in the string's length (fold 2: release N1, review-a N-c): a quantified run is
// never followed by a token its own class can match, except the JWT's, which may start only where a run
// of its class starts (the lookbehind, P0-5's form), so `\b` no longer restarts it inside "eyJ-eyJ-...".
const FORBIDDEN_TEXT = Object.freeze([
  ['http_url', /\bhttp:\/\//i], ['data_uri', /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i],
  ['secret', /\bsk-[A-Za-z0-9_-]{16,}/], ['secret', /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ['secret', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./], ['secret', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['secret', /\bAKIA[0-9A-Z]{16}\b/], ['secret', /\bxox[abposr]-[A-Za-z0-9-]{10,}/], ['secret', /password\s*[=:]/i],
].map(Object.freeze));
/** Why a string may not appear anywhere in a manifest (a FORBIDDEN_TEXT reason), or null. */
function textRefusal(value) {
  for (const [reason, pattern] of FORBIDDEN_TEXT) if (pattern.test(value)) return reason;
  return null;
}
// Containers deeper than this fail `too_deep` rather than recursing (review-b N2: the real five reach 7).
const MAX_DEPTH = 64;
function scanText(value, at, fail, skip, depth = 0) {
  if (typeof value === 'string') {
    const reason = textRefusal(value);
    if (reason) return fail(at, reason);
  } else if (value !== null && typeof value === 'object') {
    if (skip.has(value)) return;
    if (depth >= MAX_DEPTH) return fail(at, 'too_deep');
    if (Array.isArray(value)) value.forEach((item, i) => scanText(item, `${at}/${i}`, fail, skip, depth + 1));
    else for (const key of Object.keys(value)) { scanText(key, `${at}/${key}`, fail, skip, depth + 1); scanText(value[key], `${at}/${key}`, fail, skip, depth + 1); }
  }
}
// The homepage rule (a link the resident opens, never fetched by the platform): https, no userinfo.
function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password;
}
// The only endpoint form accepted (security review "ssrf-parser-differential"): lower-case ASCII DNS labels,
// at least two, no port, no userinfo, an optional path of these characters, no query, no fragment.
// ENDPOINT_FIELDS: every URL a manifest names that the platform fetches; each goes through endpointRefusal
// (fold 2, review-a N-a). `homepage` is not one: it is only rendered, as a link the resident opens.
const ENDPOINT_FIELDS = Object.freeze(['/service/baseUrl', '/service/auth/oauth/resource', '/service/auth/oauth/discovery']);
const STRICT_BASE_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*)?$/;
/**
 * Why an endpoint may not be pointed at (review-b N8; security reviews "ssrf-denylist-incomplete" and
 * "ssrf-parser-differential"; applied to every ENDPOINT_FIELDS URL), or null. Checked in this order, so
 * each refusal names its cause:
 *   'url_chars'     a non-ASCII, whitespace or control character (tab, CR, LF included) or a backslash
 *                   anywhere, or a `%` in the authority: forms other URL parsers read differently;
 *   'url'           not `https://`, an empty host, or unparseable; 'userinfo': an `@` before the path;
 *   'port'          any port the parser keeps (it drops :443, which 'not_canonical' then refuses);
 * then the host, read from the WHATWG parser (it turns decimal, hex, octal and short IPv4 forms such as
 * 2130706433, 0x7f.1, 0177.0.0.1 and 127.1 into a dotted quad, and brackets a compressed IPv6):
 *   'internal_host' a private or special address: IPv4 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
 *                   192.0.0/24, 192.168/16, 198.18/15, 224/4 and above; IPv6 ::, ::1, 64:ff9b::/96,
 *                   fc00::/7, fe80::/10, ff00::/8, and ::ffff:0:0/96 (and the old ::/96) by the IPv4 rules
 *                   of the address it carries; or a name that is single-label, localhost, *.localhost,
 *                   *.internal, *.local, *.lan, *.home.arpa, *.intranet or *.corp (lower-cased, ONE
 *                   trailing dot stripped; any other empty label is refused too);
 *   'ip_literal'    any other IP literal: a reviewed endpoint is a public DNS name;
 *   'idn'           a punycode (xn--) label;
 *   'not_canonical' not STRICT_BASE_URL, or `new URL(s).href !== s` exactly (one rule: an empty path is
 *                   written `/`; no upper-case host, trailing dot, :443, dot segment or re-encoding).
 * A static check cannot stop DNS rebinding or a public name that resolves to a private address: the
 * runtime fetcher must re-check the resolved IP at connect time (design §2, Phase 1; the cp and app own it).
 */
function endpointRefusal(value) {
  if (typeof value !== 'string' || /[^\x21-\x7e]|\\/.test(value)) return 'url_chars';
  if (!value.startsWith('https://')) return 'url';
  const authority = value.slice(8).split(/[/?#]/, 1)[0];
  if (!authority) return 'url';
  if (authority.includes('@')) return 'userinfo';
  if (authority.includes('%')) return 'url_chars';
  let url;
  try { url = new URL(value); } catch { return 'url'; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return 'url';
  if (url.port !== '') return 'port';
  const host = url.hostname.toLowerCase();
  const refused = hostRefusal(host);
  if (refused) return refused;
  if (host.split('.').some(label => label.startsWith('xn--'))) return 'idn';
  if (!STRICT_BASE_URL.test(value) || url.href !== value) return 'not_canonical';
  return null;
}
// The only target.path form accepted: "/" alone, or "/" then a character other than "/", from the schema's
// set (letters, digits, "/", "_", ".", "-": inside baseUrl's path set, with no "%", "@", ":", "~" or sub-delims).
const STRICT_TARGET_PATH = /^\/(?:[A-Za-z0-9_.-][A-Za-z0-9\/_.-]{0,198})?$/;
/**
 * Why an op's target.path may not be joined to its baseUrl (fold 2: review-b N7, with review-a N-a), or null.
 * The path is fetched against the reviewed baseUrl, so it must never change the host or leave the base:
 *   'path_chars'  not a string, or anything outside STRICT_TARGET_PATH: a backslash, "%" (so no %2f or %5c
 *                 in any case), "@", ":" (so no scheme and no host:port), "?", "#", whitespace or a control
 *                 character, a non-ASCII character, or a first character other than "/";
 *   'path_escape' "//" anywhere (a leading "//" is another host to `new URL(path, base)`), ".." anywhere,
 *                 "./" anywhere, or a final "/." (a dot segment leaves the reviewed base path);
 *   'path_origin' belt and braces: resolved against a fixed base it lands on another origin.
 * This is checked here, never only by the schema pattern, so loosening that pattern alone opens nothing.
 */
function targetPathRefusal(value) {
  if (typeof value !== 'string') return 'path_chars';
  if (value.includes('//') || value.includes('..') || value.includes('./') || value.endsWith('/.')) return 'path_escape';
  if (!STRICT_TARGET_PATH.test(value)) return 'path_chars';
  let url;
  try { url = new URL(value, 'https://base.example/'); } catch { return 'path_origin'; }
  if (url.origin !== 'https://base.example') return 'path_origin';
  return null;
}
function hostRefusal(parsed) {
  if (parsed.startsWith('[')) {
    const words = ipv6Words(parsed.slice(1, -1));
    if (!words) return 'ip_literal';
    return internalV6(words) ? 'internal_host' : 'ip_literal';
  }
  const quad = ipv4Octets(parsed);
  if (quad) return internalV4(quad) ? 'internal_host' : 'ip_literal';
  if (/^[0-9.]+$/.test(parsed)) return 'ip_literal';
  const host = parsed.endsWith('.') ? parsed.slice(0, -1) : parsed;
  if (!host || host.split('.').some(label => !label)) return 'internal_host';
  if (!host.includes('.') || /(?:^|\.)(?:localhost|internal|local|lan|home\.arpa|intranet|corp)$/.test(host)) return 'internal_host';
  return null;
}
function ipv4Octets(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every(n => n <= 255) ? octets : null;
}
function internalV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}
// The eight 16-bit words of an IPv6 address (compressed, and with a trailing dotted IPv4), or null.
function ipv6Words(text) {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = half => (half ? half.split(':') : []).flatMap(word => {
    const quad = word.includes('.') ? ipv4Octets(word) : null;
    if (quad) return [quad[0] * 256 + quad[1], quad[2] * 256 + quad[3]];
    return /^[0-9a-f]{1,4}$/.test(word) ? [parseInt(word, 16)] : [NaN];
  });
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const words = [...head, ...Array(Math.max(fill, 0)).fill(0), ...tail];
  return words.length === 8 && (halves.length === 1 || fill >= 1) && words.every(Number.isInteger) ? words : null;
}
function internalV6(w) {
  const zero = (from, to) => w.slice(from, to).every(x => x === 0);
  const carried = () => [w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255];
  if (zero(0, 8) || (zero(0, 7) && w[7] === 1)) return true; // :: and ::1
  if (zero(0, 5) && w[5] === 0xffff) return internalV4(carried()); // ::ffff:0:0/96, IPv4-mapped
  if (zero(0, 6)) return internalV4(carried()); // ::/96, the deprecated IPv4-compatible form
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return true; // 64:ff9b::/96, NAT64
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xff00) === 0xff00;
}
const utf8Bytes = value => new TextEncoder().encode(value).length;
const appSecretPrefix = id => `MINI_APP_${id.toUpperCase().replace(/-/g, '_')}_`;
function semantics(m, compileInput) {
  const errors = [];
  const fail = (path, reason) => { if (errors.length < MAX_ERRORS) errors.push({ path, reason }); };
  // Sizes before the text scan (review-b N2): an oversized input schema is refused by size and never walked.
  const oversized = new Set();
  m.operations.forEach((op, i) => {
    if (!own(op, 'input')) return;
    let size;
    try { size = utf8Bytes(JSON.stringify(op.input)); } catch { size = Infinity; }
    if (size > 16384) { oversized.add(op.input); fail(`/operations/${i}/input`, 'too_large'); }
  });
  scanText(m, '', fail, oversized);
  if (!httpsUrl(m.homepage)) fail('/homepage', 'url');
  const service = m.service, auth = service.auth;
  // Every endpoint the platform fetches, by the one rule (ENDPOINT_FIELDS: baseUrl, the OAuth resource and
  // its discovery document).
  const endpoint = (where, value) => { const refused = endpointRefusal(value); if (refused) fail(where, refused); };
  if (own(service, 'baseUrl')) endpoint('/service/baseUrl', service.baseUrl);
  if (service.kind === 'internal') {
    if (own(service, 'baseUrl')) fail('/service/baseUrl', 'internal_has_endpoint');
    if (auth) fail('/service/auth', 'internal_has_auth');
  } else if (service.kind === 'none') {
    if (own(service, 'baseUrl')) fail('/service/baseUrl', 'none_has_endpoint');
    if (auth) fail('/service/auth', 'none_has_auth');
  } else if (!auth) fail('/service/auth', 'auth_required');
  if (auth) {
    if ((auth.mode === 'oauth') !== own(auth, 'oauth')) fail('/service/auth', 'oauth_mismatch');
    if ((auth.mode === 'app-token') !== own(auth, 'secretRef')) fail('/service/auth', 'secret_ref_mismatch');
    if (auth.oauth) {
      endpoint('/service/auth/oauth/resource', auth.oauth.resource);
      endpoint('/service/auth/oauth/discovery', auth.oauth.discovery);
    }
  }
  // Reserved names and first-party grants, from the pinned table only (a manifest field never widens them).
  const grant = own(FIRST_PARTY, m.id) ? FIRST_PARTY[m.id] : null;
  if (!grant && reservedId(m.id)) fail('/id', 'reserved');
  // The env var an app-token names is sent as the bearer to the app's own baseUrl (design §2): only its
  // pinned grant, or MINI_APP_<ID>_<NAME> with no `_` in NAME (so app `acme` never names `acme-corp`'s
  // MINI_APP_ACME_CORP_TOKEN). Never a platform secret: DATABASE_URL, CP_ADMIN_TOKEN, another app's token.
  if (auth && own(auth, 'secretRef') && auth.secretRef !== grant?.secretRef) {
    const prefix = appSecretPrefix(m.id);
    if (!auth.secretRef.startsWith(prefix) || !/^[A-Z0-9]+$/.test(auth.secretRef.slice(prefix.length))) fail('/service/auth/secretRef', 'not_granted');
  }
  if (service.kind === 'internal' && !grant?.internal) fail('/service/kind', 'internal_first_party_only');
  // service.kind "none" is the pinned grant's alone (Mosaic): no ops of its own (the cp serves it the generic
  // `mini-app.read`, and the context ops per box) and a data.context block, the one thing it has. Every
  // other kind keeps at least one op (the schema's minItems before kind "none").
  if (service.kind === 'none') {
    if (!grant?.none) fail('/service/kind', 'none_first_party_only');
    if (m.operations.length) fail('/operations', 'none_has_operations');
    if (!m.data?.context) fail('/data/context', 'none_without_context');
  } else if (!m.operations.length) fail('/operations', 'operations_required');
  // `staff: true` installs the app on every agent for good: only the pinned grant may say it. `listed: false`
  // only hides an app, so any app may say it; `listed: true` is the default and widens nothing.
  if (m.staff === true && !grant?.staff) fail('/staff', 'staff_reserved');
  if (m.legacy) {
    if (!grant) fail('/legacy', 'first_party_only');
    else {
      if ((m.legacy.provenance || null) !== (grant.provenance || null)) fail('/legacy/provenance', 'not_granted');
      if (JSON.stringify(m.legacy.prefixes || []) !== JSON.stringify(grant.prefixes || [])) fail('/legacy/prefixes', 'not_granted');
      if (m.legacy.personOnly && !grant.personOnly) fail('/legacy/personOnly', 'not_granted');
    }
  }
  const prefixes = new Set([m.id, ...(grant && JSON.stringify(m.legacy?.prefixes || []) === JSON.stringify(grant.prefixes || []) ? grant.prefixes || [] : [])]);
  const byName = new Map();
  m.operations.forEach((op, i) => {
    const at = `/operations/${i}`;
    if (byName.has(op.name)) fail(`${at}/name`, 'duplicate');
    byName.set(op.name, op);
    if (!prefixes.has(op.name.split('.')[0])) fail(`${at}/name`, 'prefix');
    const target = op.target;
    if (service.kind === 'internal' && target) fail(`${at}/target`, 'internal_has_target');
    if (service.kind === 'mcp' && target && !own(target, 'tool')) fail(`${at}/target`, 'target_kind');
    if (service.kind === 'https-json' && target && !own(target, 'path')) fail(`${at}/target`, 'target_kind');
    if (target && own(target, 'path')) {
      const refused = targetPathRefusal(target.path);
      if (refused) fail(`${at}/target/path`, refused);
    }
    const card = op.class === 'needs-card';
    const value = key => own(op, key) ? op[key] : DEFAULTS[key];
    if (card && value('maxRequestBytes') > 65536) fail(`${at}/maxRequestBytes`, 'ceiling');
    if (value('maxResponseBytes') > 262144 && value('framing') !== 'media') fail(`${at}/maxResponseBytes`, 'ceiling');
    if (value('timeoutMs') > 25000 && !card) fail(`${at}/timeoutMs`, 'ceiling');
    if (own(op, 'returns') && op.class !== 'prepare') fail(`${at}/returns`, 'prepare_only');
    if (card !== own(op, 'approval')) fail(`${at}/approval`, card ? 'required' : 'needs_card_only');
    if (own(op, 'input')) {
      if (op.input.type !== 'object') fail(`${at}/input`, 'not_object_schema');
      const deep = errors.some(e => e.reason === 'too_deep' && (e.path === `${at}/input` || e.path.startsWith(`${at}/input/`)));
      if (oversized.has(op.input) || deep) return;
      if (compileInput) {
        try { compileInput(op.input, op); } catch { fail(`${at}/input`, 'uncompilable'); }
      }
    }
  });
  m.operations.forEach((op, i) => {
    if (!op.approval) return;
    const prepare = byName.get(op.approval.prepare);
    if (!prepare || prepare.class !== 'prepare') fail(`/operations/${i}/approval/prepare`, 'unknown_prepare');
    if (op.approval.card) cardRefusals(op.approval.card, prepare, `/operations/${i}/approval/card`, fail);
  });
  if (m.visibility === 'everyone' && m.data?.context?.ceiling === 'public') fail('/data/context/ceiling', 'lane_ceiling');
  const skill = m.skills[0];
  if (skill.name !== m.id) fail('/skills/0/name', 'not_app_id');
  if (skill.path !== `skills/${skill.name}/SKILL.md`) fail('/skills/0/path', 'not_skill_path');
  for (const name of Object.keys(m.events || {})) if (name.split('.')[1] !== m.id) fail(`/events/${name}`, 'not_app_id');
  const personOnly = m.legacy?.personOnly;
  if (personOnly) {
    personOnly.operations.forEach((name, i) => { if (!byName.has(name)) fail(`/legacy/personOnly/operations/${i}`, 'unknown_operation'); });
    const labels = new Set(m.permissions.map(p => p.label));
    personOnly.permissions.forEach((label, i) => { if (!labels.has(label)) fail(`/legacy/personOnly/permissions/${i}`, 'unknown_permission'); });
    if (personOnly.operations.length >= m.operations.length) fail('/legacy/personOnly/operations', 'empty_base');
    if (personOnly.permissions.length >= m.permissions.length) fail('/legacy/personOnly/permissions', 'empty_base');
  }
  return errors;
}

/**
 * The static checks of a needs-card op's `approval.card` beyond the schema (CARD-COMMON contract 1). The preview's
 * own keys are not declared anywhere static (the prepare op's `returns` names only where the preview sits and its
 * size), so "every preview key is shown or bound" is enforced where the preview is seen, at request time (the cp's
 * mini-apps-approval.js cardFields over the preview the app sends); here:
 *   'card_prepare_returns' the prepare op declares no `returns` (the preview's byte budget, previewMaxBytes);
 *   'card_path_reused'     two of the four paths are the same key, or one is inside another (a string has no keys):
 *                          the four rows are four different values;
 *   'card_path_reserved'   a shown or bound preview path in a platform key (appId, draftId, operation: bound by the
 *                          approval key, never by the app);
 *   'card_bind_reused'     a preview path bound twice;
 * and RA42 S3 (option 1, the validator): the card guarantees preview <-> card, so every argument the app acts on must
 * be bound into the preview. The prepare op declares its arguments, and each one is the root of a bound request path:
 *   'card_prepare_input_missing'        the prepare op declares no `input` object schema with at least one property;
 *   'card_prepare_input_open'           that `input` does not say `additionalProperties: false`;
 *   'card_prepare_input_unbound:<name> (bind the whole property)'
 *                                       a top-level input property that is no `bind` request path EXACTLY (security
 *                                       review fold 2: binding only a sub-path, `<name>.<...>`, leaves the property's
 *                                       other keys, a sibling amount, unbound; the whole property must be bound);
 *   'card_prepare_input_name:<name>'    (security review fold 3) a top-level input property name that is no single
 *                                       path segment (CARD_SEGMENT: no `.`, no `[`), so it cannot be compared with a
 *                                       bind request path unambiguously;
 *   'card_prepare_input_keyword:<kw>'   (security review fold) a top-level keyword of that `input` outside the closed
 *                                       allowlist CARD_INPUT_KEYWORDS (type, properties, required, additionalProperties,
 *                                       description; no `title`): patternProperties, propertyNames,
 *                                       unevaluatedProperties, dependentSchemas, allOf/anyOf/oneOf/not/if/then/else,
 *                                       $ref, ... could admit top-level keys the bind check never sees.
 * (Not expressible in the JSON Schema, which cannot relate one op's input to another op's card: a static check here.)
 */
const CARD_INPUT_KEYWORDS = Object.freeze(['type', 'properties', 'required', 'additionalProperties', 'description']);
function cardRefusals(card, prepare, at, fail) {
  if (prepare && prepare.class === 'prepare' && !prepare.returns) fail(at, 'card_prepare_returns');
  if (prepare && prepare.class === 'prepare') {
    const input = prepare.input;
    const properties = input && typeof input === 'object' && !Array.isArray(input) && input.type === 'object' &&
      input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties) ? Object.keys(input.properties) : [];
    if (!properties.length) fail(at, 'card_prepare_input_missing');
    else {
      for (const keyword of Object.keys(input)) if (!CARD_INPUT_KEYWORDS.includes(keyword)) fail(at, `card_prepare_input_keyword:${keyword}`);
      if (input.additionalProperties !== false) fail(at, 'card_prepare_input_open');
      const whole = new Set(card.bind.map(([request]) => request));
      for (const name of properties) {
        if (!CARD_SEGMENT.test(name)) fail(at, `card_prepare_input_name:${name}`);
        else if (!whole.has(name)) fail(`${at}/bind`, `card_prepare_input_unbound:${name} (bind the whole property)`);
      }
    }
  }
  const inside = (a, b) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
  const reserved = path => CARD_PLATFORM_KEYS.includes(path.split('.')[0]);
  CARD_FIELDS.forEach((field, i) => {
    if (CARD_FIELDS.slice(0, i).some(other => inside(card[field], card[other]))) fail(`${at}/${field}`, 'card_path_reused');
    if (reserved(card[field])) fail(`${at}/${field}`, 'card_path_reserved');
  });
  const bound = [];
  card.bind.forEach(([, path], i) => {
    if (reserved(path)) fail(`${at}/bind/${i}`, 'card_path_reserved');
    if (bound.includes(path)) fail(`${at}/bind/${i}`, 'card_bind_reused');
    bound.push(path);
  });
}

/**
 * Whether `value` is a v2 manifest. `compileInput(schema, op)` (optional; the cp and app pass ajv 2020
 * strict, as mcp.ts compiles a reviewed tool schema) must throw for an input schema it cannot compile.
 * Returns { ok: true, manifest } (a frozen deep copy) or { ok: false, code, errors: [{ path, reason }] }.
 */
function validateManifest(value, { compileInput } = {}) {
  let errors = checkSchema(value);
  if (!errors.length) errors = semantics(value, compileInput);
  if (errors.length) return { ok: false, code: CODE, errors };
  return { ok: true, manifest: deepFreeze(JSON.parse(JSON.stringify(value))) };
}
/**
 * The published catalog: `index` is mini-apps/catalog.json, `byId` maps each id to its parsed manifest.json
 * (or an Error when it could not be read). An index that fails is a whole-catalog failure (ok: false). A
 * manifest that fails is dropped with a code and the rest serve (design §1.2); so is one whose id is not
 * its index id, or one that reuses another's op name or prefix. A validator throw (a host stack limit, a
 * caller's compileInput) is a drop too (review-a N1), never a throw out of here.
 */
function buildCatalog(index, byId, options = {}) {
  const indexErrors = checkSchema(index, INDEX_SCHEMA);
  if (indexErrors.length) return { ok: false, code: 'mini_apps_catalog_index_invalid', errors: indexErrors };
  const manifests = [], dropped = [], ops = new Map(), prefixes = new Map();
  for (const id of index.apps) {
    const raw = byId && own(byId, id) ? byId[id] : undefined;
    if (raw === undefined || raw instanceof Error) { dropped.push({ id, code: 'mini_apps_manifest_unreadable', errors: [] }); continue; }
    let result;
    try { result = validateManifest(raw, options); } catch { result = { ok: false, code: CODE, errors: [{ path: '/', reason: 'unvalidatable' }] }; }
    if (!result.ok) { dropped.push({ id, code: result.code, errors: result.errors }); continue; }
    const m = result.manifest;
    const clash = m.id !== id ? 'id_mismatch'
      : m.operations.some(op => ops.has(op.name)) ? 'operation_taken'
        : [m.id, ...(m.legacy?.prefixes || [])].some(prefix => prefixes.has(prefix)) ? 'prefix_taken' : null;
    if (clash) { dropped.push({ id, code: CODE, errors: [{ path: '/', reason: clash }] }); continue; }
    for (const op of m.operations) ops.set(op.name, m.id);
    for (const prefix of [m.id, ...(m.legacy?.prefixes || [])]) prefixes.set(prefix, m.id);
    manifests.push(m);
  }
  return { ok: true, manifests: Object.freeze(manifests), dropped };
}

// ---- The v1 catalog entry (today's mini-apps-catalog.js shape, key order included) ----------------
const v1Unrepresentable = reason => Object.assign(new Error(V1_CODE), { code: V1_CODE, reason });
/**
 * The v1 entry a valid manifest serves, as today's constants hold it: id, name, description, version,
 * homepage, [provenance, auth, restricted], [staff, listed], [credit], permissions, skills, operations, [data], [mcp].
 * `staff` and `listed` (fold 2, release S1) are written only at their non-default value (staff: true, cp#322,
 * and only when FIRST_PARTY grants it too; listed: false, cp#325), as the cp constants hold them and the
 * overlay's gen_install_catalog.py reads them,
 * so a manifest without them (or with staff: false, listed: true) serves today's entry byte for byte. Neither
 * reaches a box: the cp's projection keeps only id, version, operations and skills.
 * `person`: the per-box person entry (legacy.personOnly kept); `context`: the per-box context entry (the
 * generic context ops after the app's own, for an app that declares data.context). A public MCP app
 * (service mcp, auth none) is served as today's generic relay: `mini-app.read` plus an `mcp` block of its
 * ops' tools; every op must be a `read`, or it throws (the relay is a read on the box). A context-only app
 * (service none, FIRST_PARTY `none`: Mosaic) is served as `mini-app.read` and its data.context with no `mcp`
 * block, as cp#334's MOSAIC and MOSAIC_CONTEXT; any other kind-none document throws (it never passed the
 * validator). A v2 `admins` app is served restricted (the narrower v1 audience: allowlisted tenants only).
 * @returns {Record<string, any>}
 */
function v1Entry(m, { person = false, context = false } = {}) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const personOnly = m.legacy?.personOnly;
  const keepOp = op => person || !personOnly || !personOnly.operations.includes(op.name);
  const keepPermission = p => person || !personOnly || !personOnly.permissions.includes(p.label);
  const relay = m.service.kind === 'mcp' && m.service.auth?.mode === 'none';
  const contextOnly = m.service.kind === 'none';
  if (contextOnly && (!(own(FIRST_PARTY, m.id) && FIRST_PARTY[m.id].none === true) || m.operations.length || !m.data?.context ||
      own(m.service, 'baseUrl') || own(m.service, 'auth'))) throw v1Unrepresentable('none_not_context_only');
  const entry = { id: m.id, name: m.name, description: m.description, version: m.version, homepage: m.homepage };
  if (m.legacy?.provenance) entry.provenance = m.legacy.provenance;
  if (m.service.auth?.mode === 'oauth') entry.auth = 'oauth';
  if (m.visibility !== 'everyone') entry.restricted = true;
  if (m.staff === true && own(FIRST_PARTY, m.id) && FIRST_PARTY[m.id].staff === true) entry.staff = true;
  if (m.listed === false) entry.listed = false;
  if (m.credit) entry.credit = { role: m.credit.role, attendeeId: m.credit.attendeeId, name: m.credit.name };
  entry.permissions = m.permissions.filter(keepPermission).map(p => ({ kind: p.kind, label: p.label, description: p.description }));
  entry.skills = m.skills.map(skill => skill.name);
  const ops = m.operations.filter(keepOp);
  entry.operations = relay || contextOnly ? [RELAY_OPERATION] : ops.map(op => op.name);
  if (context && m.data?.context) entry.operations.push(...CONTEXT_OPERATIONS);
  if (m.data?.context) entry.data = { context: { maxEntries: m.data.context.maxEntries } };
  if (relay) {
    // The v1 relay is `mini-app.read`, a read on the box (no card, no write gate): an app with any other
    // class has no v1 form (review-a S1), so it is dropped, never served as a read.
    if (m.operations.some(op => op.class !== 'read')) throw v1Unrepresentable('relay_non_read_op');
    if (!m.service.baseUrl) throw v1Unrepresentable('relay_without_base_url');
    if (ops.some(op => !op.target?.tool || !op.input)) throw v1Unrepresentable('relay_op_without_tool');
    entry.mcp = { url: m.service.baseUrl, tools: ops.map(op => ({ name: op.target.tool, inputSchema: clone(op.input) })) };
  }
  return entry;
}
/** An op's budgets with the design's defaults filled in (what P0-2 reads instead of hand tables). */
function operationBudgets(op) {
  return Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, own(op, key) ? op[key] : DEFAULTS[key]])));
}
function deepFreeze(value) {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  MANIFEST_VERSION, CODE, V1_CODE, SCHEMA, INDEX_SCHEMA, RELAY_OPERATION, CONTEXT_OPERATIONS, DEFAULTS, FIRST_PARTY, RESERVED_IDS,
  checkSchema, validateManifest, buildCatalog, v1Entry, operationBudgets, deepFreeze, endpointRefusal, ENDPOINT_FIELDS, textRefusal,
  targetPathRefusal, CARD_FIELDS, CARD_PLATFORM_KEYS, CARD_PATH,
};
