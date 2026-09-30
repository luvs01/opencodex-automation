import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clockPolicy,runClock} from '../scripts/queue-clock.mjs';
const now=Date.parse('2026-09-30T00:00:00Z');
const environment={protection_rules:[{type:'wait_timer',wait_timer:1}]};
const run={id:7,workflow_id:9,head_branch:'main',event:'workflow_dispatch',status:'in_progress',run_attempt:1,created_at:new Date(now-61_000).toISOString()};
test('probe requires real elapsed wait and configured timer',()=>assert.equal(clockPolicy('probe',environment,run,now).waitMinutes,1));
test('missing shortened or bypassed wait fails closed',()=>{
  assert.throws(()=>clockPolicy('probe',{protection_rules:[]},run,now));
  assert.throws(()=>clockPolicy('live',environment,{...run,created_at:new Date(now-3_600_000).toISOString()},now));
  assert.throws(()=>clockPolicy('probe',environment,{...run,created_at:new Date(now-30_000).toISOString()},now));
});
test('rerunning an old timer cannot duplicate its child',()=>assert.throws(()=>clockPolicy('probe',environment,{...run,run_attempt:2},now)));
function fixture(mode='probe') {
  const posts=[];
  const wf={id:9,state:'active'};
  const env=mode==='probe'?environment:{protection_rules:[{type:'wait_timer',wait_timer:60}]};
  const own={...run,created_at:new Date(now-(mode==='probe'?61_000:3_601_000)).toISOString()};
  const actions={getWorkflow:async()=>({data:wf}),getWorkflowRun:async p=>({data:p.run_id===7?own:{...own,id:p.run_id,status:'completed',conclusion:'success'}}),listWorkflowRuns:async()=>({data:{workflow_runs:[own]}}),createWorkflowDispatch:async p=>{posts.push(p)}};
  const summary={addHeading(){return this},addRaw(){return this},async write(){}};
  return {mode,github:{rest:{actions,repos:{getEnvironment:async()=>({data:env})}}},context:{repo:{owner:'luvs01',repo:'opencodex-automation'},ref:'refs/heads/main',eventName:'workflow_dispatch',runId:7,payload:{inputs:{remaining:'2'}}},core:{info(){},summary},clock:()=>now,posts};
}
test('first probe only admits one probe child, never a review',async()=>{const f=fixture();await runClock(f);assert.equal(f.posts.length,1);assert.equal(f.posts[0].workflow_id,'queue-clock-probe.yml');assert.deepEqual(f.posts[0].inputs,{parent_run_id:'7',remaining:'1'})});
test('second probe terminates without another run',async()=>{const f=fixture();f.context.payload.inputs.remaining='1';f.context.payload.inputs.parent_run_id='6';await runClock(f);assert.equal(f.posts.length,0)});
test('invalid parent completion prevents all dispatches',async()=>{const f=fixture();f.context.payload.inputs.parent_run_id='6';const original=f.github.rest.actions.getWorkflowRun;f.github.rest.actions.getWorkflowRun=async p=>p.run_id===6?{data:{...run,id:6,conclusion:'failure'}}:original(p);await assert.rejects(runClock(f));assert.equal(f.posts.length,0)});
test('probe refuses more than two hops',async()=>{const f=fixture();f.context.payload.inputs.remaining='3';await assert.rejects(runClock(f));assert.equal(f.posts.length,0)});
test('existing pending child prevents a second continuation',async()=>{const f=fixture();f.github.rest.actions.listWorkflowRuns=async()=>({data:{workflow_runs:[run,{...run,id:8,status:'waiting'}]}});await runClock(f);assert.equal(f.posts.length,0)});
test('disabled timer remains stopped',async()=>{const f=fixture();f.github.rest.actions.getWorkflow=async()=>({data:{id:9,state:'disabled_manually'}});await runClock(f);assert.equal(f.posts.length,0)});
test('production timer dispatches queue and its next delayed tick',async()=>{const f=fixture('live');await runClock(f);assert.deepEqual(f.posts.map(p=>p.workflow_id),['coderabbit-review.yml','queue-clock.yml'])});
test('disabling reviewer stops the live chain too',async()=>{const f=fixture('live');f.github.rest.actions.getWorkflow=async p=>({data:{id:9,state:p.workflow_id==='coderabbit-review.yml'?'disabled_manually':'active'}});await runClock(f);assert.equal(f.posts.length,0)});
test('ambiguous child dispatch is not retried',async()=>{const f=fixture();let calls=0;f.github.rest.actions.createWorkflowDispatch=async()=>{calls++;throw Error('timeout')};await assert.rejects(runClock(f));assert.equal(calls,1)});
