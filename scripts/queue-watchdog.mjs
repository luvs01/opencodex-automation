const OWNER = 'luvs01';
const REPO = 'opencodex-automation';
const WORKFLOW = 'coderabbit-review.yml';
const STALE_MS = 15 * 60_000;

export function trustedTrigger(context) {
  if (context.repo?.owner !== OWNER || context.repo?.repo !== REPO || context.ref !== 'refs/heads/main') return false;
  if (['schedule', 'workflow_dispatch'].includes(context.eventName)) return true;
  const run = context.payload?.workflow_run;
  return context.eventName === 'workflow_run' && run?.name === 'Queue tests' &&
    run.event === 'push' && run.head_branch === 'main' && run.conclusion === 'success' &&
    run.head_repository?.full_name === `${OWNER}/${REPO}`;
}

export function assessQueue(workflow, runs, now) {
  if (workflow.state !== 'active') return {dispatch: false, reason: 'queue-disabled'};
  const main = runs.filter(r => r.head_branch === 'main' && r.workflow_id === workflow.id);
  const active = main.find(r => r.status !== 'completed');
  if (active) return {dispatch: false, reason: 'queue-active', runId: active.id};
  const sorted = main.map(r => {
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at) || at > now + 60_000) throw new Error('Invalid queue run timestamp');
    return {...r, at};
  }).sort((a,b) => b.at - a.at);
  const last = sorted[0];
  if (last && ['cancelled', 'action_required'].includes(last.conclusion)) {
    return {dispatch: false, reason: 'queue-stopped-or-needs-approval', runId: last.id};
  }
  const ageMs = last ? Math.max(0, now - last.at) : null;
  return {dispatch: !last || ageMs >= STALE_MS, reason: !last ? 'no-queue-run' : ageMs >= STALE_MS ? 'queue-stale' : 'queue-recent',
    runId: last?.id ?? null, ageMs};
}

export async function runWatchdog({github, context, core, dryRun = true, clock = () => Date.now()}) {
  if (!trustedTrigger(context)) throw new Error('Untrusted watchdog trigger');
  const params = {owner: OWNER, repo: REPO, workflow_id: WORKFLOW};
  async function inspect() {
    const {data: workflow} = await github.rest.actions.getWorkflow(params);
    if (workflow.state !== 'active') return assessQueue(workflow, [], clock());
    const runs = [];
    for (let page = 1; page <= 10; page++) {
      const {data} = await github.rest.actions.listWorkflowRuns({...params, per_page: 100, page,
        created: `>=${new Date(clock() - 24 * 60 * 60_000).toISOString()}`});
      if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid queue history; no dispatch');
      runs.push(...data.workflow_runs);
      if (data.workflow_runs.length < 100) return assessQueue(workflow, runs, clock());
    }
    throw new Error('Incomplete queue history; no dispatch');
  }
  async function finish(result) {
    core.info(JSON.stringify(result));
    await core.summary.addHeading('Queue scheduling health').addRaw(JSON.stringify(result, null, 2)).write();
    return result;
  }
  let plan = await inspect();
  if (!plan.dispatch || dryRun) return finish({...plan, dryRun, dispatched: false});
  // A scheduled worker can appear between reads. It uses the same queue concurrency
  // and review cooldown even if it appears immediately after this second read.
  plan = await inspect();
  if (!plan.dispatch) return finish({...plan, dryRun, dispatched: false});
  // No POST retry: a transport timeout may already have admitted the dispatch.
  await github.rest.actions.createWorkflowDispatch({...params, ref: 'main', inputs: {dry_run: 'false'}});
  return finish({...plan, dryRun, dispatched: true, reason: 'recovery-dispatch-accepted'});
}
