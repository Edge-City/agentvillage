import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEWED_MINI_APPS } from "../install_miniapps";
import { AUTONOMY_FILES, AUTONOMY_GATE, AUTONOMY_JOB_NAME, AUTONOMY_JOB_SCRIPT,
  AUTONOMY_SHIPPED, autonomyMarkers, autonomySchedule, reconcileAutonomyJob } from "../zzz_autonomy_job";
import { withSymlinkPlantedAfterCheck } from "./plant_after_check";
import { createHash } from "node:crypto";

const repo = join(import.meta.dir, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const zzzbot = REVIEWED_MINI_APPS.find(app=>app.id==="zzzbot")!;
const autonomy = REVIEWED_MINI_APPS.find(app=>app.id===AUTONOMY_GATE)!;
const pair = REVIEWED_MINI_APPS.find(app=>app.id==="zzz-bridge")!;
const token = "avb_"+"a".repeat(43);
function box() {
  const home=mkdtempSync(join(tmpdir(),"av-zzz-autonomy-")); roots.push(home);
  const python=join(home,"venv/bin/python"), hermes=join(home,"bin/hermes");
  mkdirSync(join(home,"venv/bin"),{recursive:true});mkdirSync(join(home,"bin"));
  mkdirSync(join(home,"hermes_cli"));
  writeFileSync(join(home,"hermes_cli/main.py"),"# bound fake\n");
  writeFileSync(hermes,`#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${python}" "${join(home,"hermes_cli/main.py")}" "$@"\n`);
  writeFileSync(python,`#!/usr/bin/env bash\nif [ "$1" = "-c" ]; then\n shift 2\n exec "${process.execPath}" "${join(import.meta.dir,"fake_hermes_job_python.ts")}" "$@"\nfi\nshift\nexec "${process.execPath}" "${join(import.meta.dir,"fake_hermes.ts")}" "$@"\n`);
  chmodSync(hermes,0o755);chmodSync(python,0o755);
  writeFileSync(join(home,"village-bridge.json"),JSON.stringify({origin:"https://agents.edgecity.live",token,
    expiresAt:"2099-01-01T00:00:00Z"}));
  const stage=(apps: readonly unknown[],args:string[]=[],extraEnv:Record<string,string>={})=>spawnSync(process.execPath,
    ["--no-env-file","--no-install","install/install_miniapps.ts",...args],{cwd:repo,
      input:JSON.stringify({version:1,apps}),env:{...process.env,HERMES_HOME:home,HERMES_BIN:hermes,...extraEnv},encoding:"utf8"});
  const jobs=()=>JSON.parse(readFileSync(join(home,"cron/jobs.json"),"utf8")).jobs as Array<Record<string,unknown>>;
  return {home,stage,jobs};
}

test("reviewed event gate is independent of the private-pair gate and owns one exact no-agent job",()=>{
  expect(autonomy).toEqual({id:AUTONOMY_GATE,version:"1.0.0",operations:[],skills:[]});
  const {home,stage,jobs}=box();
  expect(stage([zzzbot]).status).toBe(0);
  expect(existsSync(join(home,"cron/jobs.json"))).toBe(false);
  expect(stage([zzzbot,pair]).status).toBe(0);
  expect(jobs().map(job=>job.name)).toEqual(["Edge — zzz pairs"]);
  expect(stage([zzzbot,pair,autonomy]).status).toBe(0);
  expect(jobs().map(job=>job.name).sort()).toEqual(["Edge — zzz event autonomy","Edge — zzz pairs"]);
  const job=jobs().find(job=>job.name===AUTONOMY_JOB_NAME)!;
  expect(job).toMatchObject({script:AUTONOMY_JOB_SCRIPT,no_agent:true,enabled:true,enabled_toolsets:["no_mcp"],
    schedule:{kind:"cron",expr:autonomySchedule(token)}});
  expect(readFileSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toEqual(readFileSync(join(repo,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT)));
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot,pair,autonomy],["--verify"]).status).toBe(0);
  expect(stage([zzzbot,pair]).status).toBe(0);
  expect(jobs().map(job=>job.name)).toEqual(["Edge — zzz pairs"]);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(false);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot,pair],["--verify"]).status).toBe(0);
});

test("gate without zzzbot stages no job and malformed gate fails closed",()=>{
  const {home,stage}=box();
  expect(stage([autonomy]).status).toBe(0);
  expect(existsSync(join(home,"cron/jobs.json"))).toBe(false);
  expect(stage([zzzbot,{...autonomy,operations:["zzz.reply"]}]).status).toBe(1);
  expect(autonomyMarkers(home)).toBe(false);
});

test("every shipped runner fits the installer's 65,536-byte ownership cap",()=>{
  // ownedFile treats a file over 65,536 bytes as not_ours: a runner past it would never upgrade or tear down on a box.
  for (const relative of AUTONOMY_FILES) {
    const size=readFileSync(join(repo,"skills/zzzbot",relative)).length;
    expect(size).toBeLessThanOrEqual(65536);
  }
  expect(readFileSync(join(repo,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT)).length).toBeLessThanOrEqual(65536);
});

test("first shipped bytes are pinned and teardown preserves resident replacement",()=>{
  for (const relative of AUTONOMY_FILES) {
    const digest=createHash("sha256").update(readFileSync(join(repo,"skills/zzzbot",relative))).digest("hex");
    expect(AUTONOMY_SHIPPED[relative]).toContain(digest);
  }
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const shim=join(home,"scripts",AUTONOMY_JOB_SCRIPT);
  writeFileSync(shim,"resident replacement");
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(readFileSync(shim,"utf8")).toBe("resident replacement");
});

test("a box holding the previous runner bytes upgrades to the current bytes, then tears down cleanly",()=>{
  const previous=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.ov528.py.fixture"));
  const current=readFileSync(join(repo,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT));
  const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
  expect(digest(previous)).toBe("f25327ecfb2781969d511c23c1c1c4e5e93e829f9abae1384d3b582174b3061e");
  expect(previous.equals(current)).toBe(false);
  // v2.1.19/v2.1.20 boxes hold ov#526's bytes; topic tags (lead L30725) appended a third digest, every older one kept.
  const v2119=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.v2119.py.fixture"));
  expect(digest(v2119)).toBe("95b64ed6eef6d42897e7ad4f922266fbbf1320abeaeeee9f28e06ca9a1d51c9c");
  // v2.1.21 boxes hold the topic-tags bytes; zzzbot 1.1.0 by the exact ZZZBOT_ACCEPTED (RUNNER-ZZZBOT-110) appended a fourth digest.
  const v2121=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.v2121.py.fixture"));
  expect(digest(v2121)).toBe("f71f3c5d48c90ca8dcbdfa22a58c945dcf3d6e54640536ca30194722e0d97a32");
  expect(v2121.equals(current)).toBe(false);
  // ov#548's bytes (main before v2.1.22's tag); the stdlib-only model route (ov#550) appended a fifth digest.
  const ov548=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.ov548.py.fixture"));
  expect(digest(ov548)).toBe("cd566df9f69d257a4f75e0d59e331902381ff9bb61ed0e2945d1bedf6e7a3f78");
  expect(ov548.equals(current)).toBe(false);
  // ov#550's first head (8821169a, stdlib-only route); PyYAML first with the stdlib fallback (review-b S1) appended a sixth.
  const ov550=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.ov550-stdlib.py.fixture"));
  expect(digest(ov550)).toBe("5db8a0da4210b5145b55d713e0a97a5a0627332b1f6728c4bf30261432838e45");
  expect(ov550.equals(current)).toBe(false);
  // v2.1.22's bytes (ov#550's final head, the canary's runner); the config-key OpenRouter route (RUNNER-MODEL-RESOLVE) appended a seventh.
  const v2122=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.v2122.py.fixture"));
  expect(digest(v2122)).toBe("e6edc00f2b8f02ab87787f0592645fa134c6bbfa68de36a349f34c0f6113c498");
  expect(v2122.equals(current)).toBe(false);
  // ov#553's bytes (main before this change, the v2.1.23 rider); ODIN's seat_answer posted as given (data L32206) appended an eighth.
  const ov553=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.ov553.py.fixture"));
  expect(digest(ov553)).toBe("06607497360fc59bd9507eccab0a40280a321f9bab6bf6e31e6c574f1dee8ef5");
  expect(ov553.equals(current)).toBe(false);
  // v2.1.24-v2.1.26's bytes (ov#554, main before this change); owner_instruction (lead L34271) appended a ninth.
  const v2124=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.v2124.py.fixture"));
  expect(digest(v2124)).toBe("0fb7fbc2a1b652ce4d5ecbf64a292c0af0879d436942d2962599642b06c24450");
  expect(v2124.equals(current)).toBe(false);
  // ov#579's bytes (main 1ebf9377, owner_instruction); village_knowledge (lead L34507) + the app's versioned instructions
  // block (lead L34695) appended a tenth (ov#582 + ov#584 merged).
  const ov579=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.ov579.py.fixture"));
  expect(digest(ov579)).toBe("135a21654534a6afa2096d59f99444a9e673e52e756586134fa4fb050db35a6a");
  expect(ov579.equals(current)).toBe(false);
  expect(AUTONOMY_SHIPPED[AUTONOMY_FILES[0]]).toEqual([digest(previous),digest(v2119),digest(v2121),digest(ov548),digest(ov550),digest(v2122),digest(ov553),digest(v2124),digest(ov579),digest(current)]);
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const shim=join(home,"scripts",AUTONOMY_JOB_SCRIPT);
  const skillCopy=join(home,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT);
  // The box as v2.1.22 left it (the canary): v2.1.22's bytes in the shim and the staged skill copy.
  writeFileSync(shim,v2122,{mode:0o700});
  if (existsSync(skillCopy)) writeFileSync(skillCopy,v2122);
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(readFileSync(shim).equals(current)).toBe(true);
  expect(jobs().map(job=>job.name)).toEqual([AUTONOMY_JOB_NAME]);
  expect(stage([zzzbot,autonomy],["--verify"]).status).toBe(0);
  // The same upgrade from the first shipped bytes.
  writeFileSync(shim,previous,{mode:0o700});
  if (existsSync(skillCopy)) writeFileSync(skillCopy,previous);
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(readFileSync(shim).equals(current)).toBe(true);
  expect(jobs().map(job=>job.name)).toEqual([AUTONOMY_JOB_NAME]);
  // The same upgrade from the v2.1.19 bytes (what every box runs today).
  writeFileSync(shim,v2119,{mode:0o700});
  if (existsSync(skillCopy)) writeFileSync(skillCopy,v2119);
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(readFileSync(shim).equals(current)).toBe(true);
  expect(stage([zzzbot,autonomy],["--verify"]).status).toBe(0);
  // And from the v2.1.21 bytes (the fleet at v2.1.22's cut), ov#548's, ov#550's first head, ov#553's, v2.1.24's and ov#579's.
  for (const older of [v2121,ov548,ov550,ov553,v2124,ov579]) {
    writeFileSync(shim,older,{mode:0o700});
    if (existsSync(skillCopy)) writeFileSync(skillCopy,older);
    expect(stage([zzzbot,autonomy]).status).toBe(0);
    expect(readFileSync(shim).equals(current)).toBe(true);
  }
  // Teardown straight from the previous bytes also removes the shim and the job.
  writeFileSync(shim,previous,{mode:0o700});
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(existsSync(shim)).toBe(false);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});

test("failed stage withdraws only the autonomy gate before tearing down its job",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,pair,autonomy]).status).toBe(0);
  expect(stage([zzzbot,pair,{...autonomy,skills:["unreviewed"]}]).status).toBe(1);
  expect(JSON.parse(readFileSync(join(home,"mini-apps.json"),"utf8")).apps.map((app:{id:string})=>app.id))
    .toEqual(["zzzbot","zzz-bridge"]);
  // The existing failClosedZzz also removes its pair job on any failed stage.
  expect(jobs()).toEqual([]);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(false);
});

test("failed Hermes teardown withdraws the gate, keeps the teardown pending, and the next stage removes the job",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const failing=join(home,"bin","fail-hermes");
  writeFileSync(failing,"#!/usr/bin/env bash\nexit 1\n");chmodSync(failing,0o755);
  expect(stage([zzzbot,{...autonomy,skills:["unreviewed"]}],[],{HERMES_BIN:failing}).status).toBe(1);
  expect(JSON.parse(readFileSync(join(home,"mini-apps.json"),"utf8")).apps.map((app:{id:string})=>app.id))
    .toEqual(["zzzbot"]);
  // The job is inert (the projection gate is gone) but not forgotten: it stays a marker, and its files stay while it
  // remains, so no stage can call the box clean.
  expect(jobs().map(job=>job.name)).toEqual([AUTONOMY_JOB_NAME]);
  expect(autonomyMarkers(home)).toBe(true);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(true);
  expect(stage([zzzbot],["--verify"]).status).toBe(1);
  // The next normal stage retries the removal and finishes the teardown.
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(false);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});

test("a job under the reserved name with a drifted prompt or toolsets is still torn down, or updated in place",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const path=join(home,"cron/jobs.json");
  const drift=(change:Record<string,unknown>)=>{
    const doc=JSON.parse(readFileSync(path,"utf8"));
    doc.jobs=doc.jobs.map((job:Record<string,unknown>)=>job.name===AUTONOMY_JOB_NAME?{...job,...change}:job);
    writeFileSync(path,JSON.stringify(doc));
  };
  // An older release's prompt (or a resident edit) is updated in place, never a name conflict.
  drift({prompt:"an older prompt",enabled_toolsets:["web"]});
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(jobs().filter(job=>job.name===AUTONOMY_JOB_NAME)).toHaveLength(1);
  expect(stage([zzzbot,autonomy],["--verify"]).status).toBe(0);
  // Drifted again, then the gate is removed: the job still goes.
  drift({prompt:"an older prompt",enabled_toolsets:["web"]});
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});

test("a dangling resident shim symlink never creates its outside target",()=>{
  const {home,stage}=box();
  mkdirSync(join(home,"scripts"));
  const target=join(home,"outside-target");
  symlinkSync(target,join(home,"scripts",AUTONOMY_JOB_SCRIPT));
  expect(stage([zzzbot,autonomy]).status).toBe(1);
  expect(existsSync(target)).toBe(false);
  expect(JSON.parse(readFileSync(join(home,"mini-apps.json"),"utf8")).apps.map((app:{id:string})=>app.id))
    .toEqual(["zzzbot"]);
});

test("v2.1.20: a symlink swapped in after the shim check is replaced, never followed (temp file + rename)",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,pair,autonomy]).status).toBe(0);
  const shim=join(home,"scripts",AUTONOMY_JOB_SCRIPT), outside=join(home,"outside-target");
  unlinkSync(shim);
  writeFileSync(outside,"resident outside file");
  const saved={HERMES_HOME:process.env.HERMES_HOME,HERMES_BIN:process.env.HERMES_BIN};
  process.env.HERMES_HOME=home; process.env.HERMES_BIN=join(home,"bin/hermes");
  try {
    // ownedFile(shim) sees no shim ("absent"); the symlink lands between that check and the write.
    expect(withSymlinkPlantedAfterCheck(shim,outside,()=>reconcileAutonomyJob(home,true)).planted).toBe(true);
  } finally {
    for (const [key,value] of Object.entries(saved)) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
  }
  expect(readFileSync(outside,"utf8")).toBe("resident outside file");
  const meta=lstatSync(shim);
  expect(meta.isFile()&&!meta.isSymbolicLink()).toBe(true);
  expect(meta.mode&0o777).toBe(0o700);
  expect(readFileSync(shim)).toEqual(readFileSync(join(repo,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT)));
  expect(readdirSync(join(home,"scripts")).filter(name=>name.endsWith(".tmp"))).toEqual([]);
  expect(jobs().filter(job=>job.name===AUTONOMY_JOB_NAME)).toHaveLength(1);
});

test("a resident job that only mentions the reserved name is not a marker; the real job still is",()=>{
  const {home,stage,jobs}=box();
  mkdirSync(join(home,"cron"),{recursive:true});
  const resident=[
    {id:"bbbbbbbbbbbb",name:"Daily digest",prompt:`Summarise what ${AUTONOMY_JOB_NAME} posted today.`,enabled:true},
    {id:"cccccccccccc",name:`${AUTONOMY_JOB_NAME} (my notes)`,prompt:"notes",enabled:true},
  ];
  // The escaped spelling (—) too: the substring test over the raw store must not decide the marker.
  writeFileSync(join(home,"cron/jobs.json"),JSON.stringify({jobs:resident}).replaceAll("—","\\u2014"));
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot]).status).toBe(0);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
  expect(jobs()).toEqual(resident);
  // The real job (exact name) is a marker, installs beside the resident jobs, and its teardown leaves them alone.
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot,autonomy],["--verify"]).status).toBe(0);
  expect(jobs().map(job=>job.name)).toEqual([...resident.map(job=>job.name),AUTONOMY_JOB_NAME]);
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual(resident);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});

test("teardown removes a FIFO (or any non-regular file) at the runner's state names",()=>{
  const {home,stage}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const state=join(home,"zzzbot");
  mkdirSync(state,{recursive:true,mode:0o700});
  const fifo=join(state,"autonomy-backoff.json"), lock=join(state,"autonomy-run.lock");
  expect(spawnSync("mkfifo",[fifo]).status).toBe(0);
  symlinkSync(join(home,"village-bridge.json"),lock);
  expect(stage([zzzbot]).status).toBe(0);
  for (const path of [fifo,lock]) expect(()=>lstatSync(path)).toThrow();
  // The symlink's target is untouched.
  expect(existsSync(join(home,"village-bridge.json"))).toBe(true);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});
