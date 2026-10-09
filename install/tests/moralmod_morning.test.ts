import {test,expect} from "bun:test";
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {morningSource,installMorning} from "../moralmod_morning";
import {INDEX_PLUGIN_REVISION} from "../moralmod_release";
const repo=resolve(import.meta.dir,"../../../index-hermes-plugin");
const pinned=Bun.spawnSync(["git","show",`${INDEX_PLUGIN_REVISION}:morning.py`],{cwd:repo});
test.skipIf(pinned.exitCode!==0)("actual pinned Python cron uses opt-out, reconciles one job and preserves pause",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mm-morning-"));
 try {
  const source=join(dir,"morning.py");writeFileSync(source,morningSource(pinned.stdout.toString()));
  const script=String.raw`
import runpy,sys,types,tempfile
from pathlib import Path
m=runpy.run_path(sys.argv[1])
f=m['morning_brief_wanted']
assert f({}) and f({'notificationPreferences':{}})
assert f({'notificationPreferences':{'morningBrief':True}})
assert not f(None) and not f({'notificationPreferences':{'morningBrief':False}})
assert not f({'notificationPreferences':{'morningBrief':'yes'}})
jobs=[{'id':'one','name':'Index morning','schedule_display':'0 8 * * *','state':'paused'}, {'id':'duplicate','name':'Index morning'}]
changes=[]
c=types.ModuleType('cron.jobs')
c.list_jobs=lambda **kw: jobs
c.remove_job=lambda id: jobs.__setitem__(slice(None),[j for j in jobs if j['id']!=id])
def update(id,body):
 changes.append(body);jobs[0].update(schedule_display=body['schedule']);return jobs[0]
c.update_job=update
c.create_job=lambda *a,**kw: (_ for _ in ()).throw(AssertionError('duplicate created'))
sys.modules['cron']=types.ModuleType('cron');sys.modules['cron.jobs']=c
m['sync_morning_cron'].__globals__['_morning_opted_in']=lambda:True
home=Path(tempfile.mkdtemp())
m['sync_morning_cron'](home,True);m['sync_morning_cron'](home,True)
assert len(jobs)==1 and jobs[0]['state']=='paused' and len(changes)==1
assert changes[0]['schedule']=='*/5 * * * *'
m['sync_morning_cron'].__globals__['_morning_opted_in']=lambda:None
m['sync_morning_cron'](home,True)
assert len(jobs)==1
m['sync_morning_cron'](home,False)
assert not jobs and not (home/'scripts/index-morning.py').exists()
import shutil;shutil.rmtree(home)
`;
  const r=Bun.spawnSync(["python3","-c",script,source]);expect(r.stderr.toString()).toBe("");expect(r.exitCode).toBe(0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test.skipIf(pinned.exitCode!==0)("owned installer is repeatable and refuses a modified morning file",()=>{
 const home=mkdtempSync(join(tmpdir(),"mm-morning-install-"));
 try {
  Bun.spawnSync(["mkdir","-p",join(home,"plugins")]);
  expect(Bun.spawnSync(["git","clone","--quiet",repo,join(home,"plugins/index-network")]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git","checkout","--quiet",INDEX_PLUGIN_REVISION],{cwd:join(home,"plugins/index-network")} ).exitCode).toBe(0);
  installMorning(home);installMorning(home);
  const file=join(home,"plugins/index-network/morning.py");
  expect(readFileSync(file,"utf8")).toBe(morningSource(pinned.stdout.toString()));
  writeFileSync(file,readFileSync(file,"utf8")+"# unowned change\n");expect(()=>installMorning(home)).toThrow("Unowned");
 } finally {rmSync(home,{recursive:true,force:true});}
});
