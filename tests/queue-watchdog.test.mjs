import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trustedTrigger, assessQueue, runWatchdog} from '../scripts/queue-watchdog.mjs';
const now = Date.parse('2026-09-29T22:00:00Z');
const workflow = {id: 123, state: 'active'};
const ctx = {repo:{owner:'luvs01',repo:'opencodex-automation'},ref:'refs/heads/main',eventName:'schedule'};
const queueRun = (age=20*60_000, overrides={}) => ({id:456,workflow_id:123,head_branch:'main',status:'completed',conclusion:'success',created_at:new Date(now-age).toISOString(),...overrides});
test('disabled workflow remains disabled',()=>assert.equal(assessQueue({...workflow,state:'disabled_manually'},[],now).reason,'queue-disabled'));
test('all unfinished run states prevent duplicate dispatch',()=>{
  for(const status of ['queued','in_progress','waiting','requested','pending']) assert.equal(assessQueue(workflow,[queueRun(999999,{status})],now).reason,'queue-active');
});
test('recent successful or failed run honors fifteen-minute recovery interval',()=>{
  for(const conclusion of ['success','failure']) assert.equal(assessQueue(workflow,[queueRun(14*60_000,{conclusion})],now).dispatch,false);
});
test('stale or absent invocation permits one recovery',()=>{
  assert.equal(assessQueue(workflow,[queueRun(15*60_000)],now).dispatch,true);
  assert.equal(assessQueue(workflow,[],now).dispatch,true);
});
test('manual cancellation and approval requirements are not retried',()=>{
  for(const conclusion of ['cancelled','action_required']) assert.equal(assessQueue(workflow,[queueRun(99*60_000,{conclusion})],now).dispatch,false);
});
test('unrelated workflows and non-main runs do not hide missing main worker',()=>{
  assert.equal(assessQueue(workflow,[queueRun(0,{workflow_id:7}),queueRun(0,{head_branch:'untrusted'})],now).dispatch,true);
});
test('invalid and future timestamps fail closed',()=>{
  for(const created_at of ['invalid',new Date(now+120_000).toISOString()]) assert.throws(()=>assessQueue(workflow,[queueRun(0,{created_at})],now));
});
test('only expected repository and main branch can trigger recovery',()=>{
  assert.equal(trustedTrigger(ctx),true);
  assert.equal(trustedTrigger({...ctx,ref:'refs/heads/feature'}),false);
  assert.equal(trustedTrigger({...ctx,repo:{owner:'luvs01',repo:'opencodex'}}),false);
});
const pushRun = {name:'Queue tests',event:'push',head_branch:'main',conclusion:'success',head_repository:{full_name:'luvs01/opencodex-automation'}};
test('test-completion fallback accepts only successful trusted main pushes',()=>{
  const context={...ctx,eventName:'workflow_run',payload:{workflow_run:pushRun}};
  assert.equal(trustedTrigger(context),true);
  for(const patch of [{event:'pull_request'},{head_branch:'feature'},{conclusion:'failure'},{name:'CodeRabbit review queue'},{head_repository:{full_name:'stranger/repo'}}]) assert.equal(trustedTrigger({...context,payload:{workflow_run:{...pushRun,...patch}}}),false);
});
function fixture(snapshots=[[queueRun()]]) {
  let reads=0, posts=0;
  const github={rest:{actions:{
    getWorkflow:async()=>({data:workflow}),
    listWorkflowRuns:async()=>({data:{workflow_runs:snapshots[Math.min(reads++,snapshots.length-1)]}}),
    createWorkflowDispatch:async p=>{posts++;assert.deepEqual(p,{owner:'luvs01',repo:'opencodex-automation',workflow_id:'coderabbit-review.yml',ref:'main',inputs:{dry_run:'false'}})}
  }}};
  const summary={addHeading(){return this},addRaw(){return this},async write(){}};
  return {github,context:ctx,core:{info(){},summary},clock:()=>now,posts:()=>posts};
}
test('dry-run never dispatches',async()=>{const f=fixture();assert.equal((await runWatchdog({...f,dryRun:true})).dispatched,false);assert.equal(f.posts(),0)});
test('stale queue dispatches exactly once after recheck',async()=>{const f=fixture();assert.equal((await runWatchdog({...f,dryRun:false})).dispatched,true);assert.equal(f.posts(),1)});
test('worker appearing during final recheck prevents dispatch',async()=>{const f=fixture([[queueRun()],[queueRun(0,{status:'queued'})]]);await runWatchdog({...f,dryRun:false});assert.equal(f.posts(),0)});
test('incomplete history prevents dispatch',async()=>{const f=fixture([Array(100).fill(queueRun())]);await assert.rejects(runWatchdog({...f,dryRun:false}));assert.equal(f.posts(),0)});
test('history pagination reaches a queued run on the next page',async()=>{const f=fixture([Array(100).fill(queueRun()),[queueRun(0,{status:'queued'})]]);const result=await runWatchdog({...f,dryRun:false});assert.equal(result.reason,'queue-active');assert.equal(f.posts(),0)});
test('ambiguous dispatch is not retried',async()=>{const f=fixture();let calls=0;f.github.rest.actions.createWorkflowDispatch=async()=>{calls++;throw Error('timeout')};await assert.rejects(runWatchdog({...f,dryRun:false}));assert.equal(calls,1)});
test('untrusted trigger performs no API access',async()=>{const f=fixture();f.github.rest.actions.getWorkflow=async()=>{throw Error('API must not be called')};await assert.rejects(runWatchdog({...f,context:{...ctx,eventName:'pull_request'}}),/Untrusted/)});
