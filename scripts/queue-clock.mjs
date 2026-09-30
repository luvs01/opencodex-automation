const owner = 'luvs01', repo = 'opencodex-automation';
const modes = {
  probe: {workflow: 'queue-clock-probe.yml', environment: 'review-clock-probe', minutes: 1},
  live: {workflow: 'queue-clock.yml', environment: 'review-clock-hourly', minutes: 60},
};
export function clockPolicy(mode, environment, run, now) {
  const config = modes[mode];
  if (!config) throw new Error('Unknown clock mode');
  if (run.run_attempt !== 1) throw new Error('Do not replay a timer run; inspect admitted children first');
  const wait = environment.protection_rules?.find(r=>r.type==='wait_timer')?.wait_timer;
  if (wait !== config.minutes) throw new Error('Required environment wait timer is not configured');
  const elapsed = now - Date.parse(run.created_at);
  if (!Number.isFinite(elapsed) || elapsed < config.minutes*60_000) throw new Error('Timer was bypassed or has not elapsed');
  return {mode,waitMinutes:wait,elapsedMs:elapsed};
}
export async function runClock({mode,github,context,core,clock=()=>Date.now()}) {
  const config=modes[mode];
  if (!config || context.repo?.owner!==owner || context.repo?.repo!==repo || context.ref!=='refs/heads/main' || context.eventName!=='workflow_dispatch') throw new Error('Untrusted timer context');
  const remaining=Number(context.payload?.inputs?.remaining??2);
  if (mode==='probe' && ![1,2].includes(remaining)) throw new Error('Probe is limited to two invocations');
  const self={owner,repo,workflow_id:config.workflow};
  const {data:workflow}=await github.rest.actions.getWorkflow(self);
  if (workflow.state!=='active') return {reason:'clock-disabled',dispatched:false};
  const {data:run}=await github.rest.actions.getWorkflowRun({owner,repo,run_id:context.runId});
  if (run.workflow_id!==workflow.id || run.head_branch!=='main' || run.event!=='workflow_dispatch') throw new Error('Run identity mismatch');
  const {data:environment}=await github.rest.repos.getEnvironment({owner,repo,environment_name:config.environment});
  const result=clockPolicy(mode,environment,run,clock());
  const parentId=context.payload?.inputs?.parent_run_id;
  if(parentId) {
    if(!/^\d+$/.test(parentId) || parentId===String(context.runId)) throw new Error('Invalid timer parent');
    const {data:parent}=await github.rest.actions.getWorkflowRun({owner,repo,run_id:Number(parentId)});
    if(parent.workflow_id!==workflow.id || parent.head_branch!=='main' || parent.conclusion!=='success') throw new Error('Parent timer did not finish successfully');
    result.parentRunId=parent.id;
  }
  let queueDispatched=false;
  if(mode==='live') {
    const {data:queue}=await github.rest.actions.getWorkflow({owner,repo,workflow_id:'coderabbit-review.yml'});
    if(queue.state!=='active') return {reason:'queue-disabled',dispatched:false};
    // The existing queue remains the sole reviewer and enforces all cooldowns.
    await github.rest.actions.createWorkflowDispatch({owner,repo,workflow_id:'coderabbit-review.yml',ref:'main',inputs:{dry_run:'false'}});
    queueDispatched=true;
  }
  let continued=false;
  if(mode==='live' || remaining>1) {
    const {data:current}=await github.rest.actions.getWorkflow(self);
    if(current.state==='active') {
      const {data}=await github.rest.actions.listWorkflowRuns({...self,per_page:100,page:1,
        created:`>=${new Date(clock()-24*60*60_000).toISOString()}`});
      if(!Array.isArray(data.workflow_runs)||data.workflow_runs.length>=100) throw new Error('Cannot establish unique timer continuation');
      const other=data.workflow_runs.some(r=>r.id!==context.runId && r.head_branch==='main' && r.status!=='completed');
      if(!other) {
        const inputs={parent_run_id:String(context.runId)};
        if(mode==='probe') inputs.remaining=String(remaining-1);
        // Deliberately no POST retry; read actual child runs after ambiguous errors.
        await github.rest.actions.createWorkflowDispatch({...self,ref:'main',inputs});
        continued=true;
      }
    }
  }
  const final={...result,queueDispatched,continued,runId:context.runId};
  core.info(JSON.stringify(final));
  await core.summary.addHeading('Internal review clock').addRaw(JSON.stringify(final,null,2)).write();
  return final;
}
