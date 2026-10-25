/** Local-only stand-in for the Hermes Python job store API invoked by the installer. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HERMES_HOME!;
if (process.env.PYTHONPATH || process.env.PYTHONHOME) process.exit(2);
const path = join(home, "cron", "jobs.json");
// Hermes v2026.9.24 cron/jobs.py load_jobs(), the shapes the review-b N2 tests use: a BOM is dropped; the canonical
// {"jobs": [...]}, an id-keyed {"jobs": {id: job}} map (flattened), or a bare list. save_jobs() writes it canonical.
function load(): Record<string, any>[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  let data: any;
  // strict=False: a raw control character inside a string (the fixtures put them only inside strings).
  try { data = JSON.parse(text); } catch { data = JSON.parse(text.replace(/[\u0000-\u0009\u000b-\u001f]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))); }
  if (Array.isArray(data)) return data;
  const list = data.jobs ?? [];
  if (Array.isArray(list)) return list;
  return Object.entries(list).filter(([, job]) => job && typeof job === "object").map(([key, job]: [string, any]) => ({ ...job, id: job.id || key }));
}
const jobs = load();
const request = JSON.parse(await Bun.stdin.text());
if (request.action === "remove") {
  const index = jobs.findIndex(job => job.id === request.id && job.name === request.name);
  if (index < 0) process.exit(1);
  jobs.splice(index, 1);
} else {
  const old = jobs.find(job => job.id === request.id);
  if (request.id && (!old || old.name !== request.name)) process.exit(1);
  const safe = old && old.script === request.script && old.no_agent === true && !old.workdir
    && JSON.stringify(old.enabled_toolsets) === JSON.stringify(request.toolsets)
    && old.deliver === "local" && old.failure_deliver === "local"
    && old.schedule?.kind === "cron" && old.schedule?.expr === request.schedule
    && old.repeat?.times === null && !old.skills?.length && !old.skill && !old.context_from?.length
    && !old.monitor_script && !old.monitor_url;
  if (old && !safe) jobs.splice(jobs.indexOf(old), 1);
  const job = safe ? old : { id: randomBytes(6).toString("hex"), name: request.name };
  Object.assign(job, { prompt: request.prompt, script: request.script,
    enabled_toolsets: request.toolsets, enabled: true, no_agent: true, workdir: null,
    deliver: "local", failure_deliver: "local", schedule: { kind: "cron", expr: request.schedule, display: request.schedule },
    repeat: { times: null, completed: 0 }, skills: [], skill: null, context_from: null,
    monitor_script: null, monitor_url: null });
  if (!safe) jobs.push(job);
}
mkdirSync(join(home, "cron"), { recursive: true });
writeFileSync(path, JSON.stringify({ jobs }));
