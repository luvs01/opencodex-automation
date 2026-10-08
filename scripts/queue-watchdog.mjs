const OWNER = 'luvs01';
const REPO = 'opencodex-automation';
const WORKFLOW = 'coderabbit-review.yml';
const CLOCK_WORKFLOW = 'queue-clock.yml';
const STALE_MS = 15 * 60_000;
const ALERT_MARKER = '<!-- ocx-watchdog-alert -->';
const ALERT_TITLE = 'OpenCodex queue watchdog alert';

export function trustedTrigger(context) {
  if (context.repo?.owner !== OWNER || context.repo?.repo !== REPO || context.ref !== 'refs/heads/main') return false;
  if (['schedule', 'workflow_dispatch'].includes(context.eventName)) return true;
  const run = context.payload?.workflow_run;
  return context.eventName === 'workflow_run' && run?.name === 'Queue tests' &&
    run.event === 'push' && run.head_branch === 'main' && run.conclusion === 'success' &&
    run.head_repository?.full_name === `${OWNER}/${REPO}`;
}

function mainRuns(workflow, runs, now) {
  return runs.filter(r => r.head_branch === 'main' && r.workflow_id === workflow.id).map(r => {
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at) || at > now + 60_000) throw new Error('Invalid run timestamp');
    return {...r, at};
  }).sort((a,b) => b.at - a.at);
}

export function assessQueue(workflow, runs, now) {
  if (workflow.state !== 'active') return {dispatch: false, reason: 'queue-disabled'};
  const sorted = mainRuns(workflow, runs, now);
  const active = sorted.find(r => r.status !== 'completed');
  if (active) return {dispatch: false, reason: 'queue-active', runId: active.id};
  const last = sorted[0];
  if (last && ['cancelled', 'action_required'].includes(last.conclusion)) {
    return {dispatch: false, reason: 'queue-stopped-or-needs-approval', runId: last.id};
  }
  const ageMs = last ? Math.max(0, now - last.at) : null;
  return {dispatch: !last || ageMs >= STALE_MS, reason: !last ? 'no-queue-run' : ageMs >= STALE_MS ? 'queue-stale' : 'queue-recent',
    runId: last?.id ?? null, ageMs};
}

// The internal clock is a self-dispatching chain: each successful tick admits the
// next one, so a lost child dispatch or a failed tick ends the chain silently. A
// manually cancelled or approval-blocked last run means a person stopped it — the
// watchdog reports but never restarts it.
export function assessClock(workflow, runs, now) {
  if (workflow.state !== 'active') return {clock: 'disabled', dispatch: false};
  const sorted = mainRuns(workflow, runs, now);
  const live = sorted.find(r => r.status !== 'completed');
  if (live) return {clock: 'alive', dispatch: false, runId: live.id};
  const last = sorted[0];
  if (last && ['cancelled', 'action_required'].includes(last.conclusion)) {
    return {clock: 'stopped', dispatch: false, runId: last.id};
  }
  return {clock: 'dead', dispatch: true, runId: last?.id ?? null};
}

export async function runWatchdog({github, context, core, dryRun = true, clock = () => Date.now()}) {
  if (!trustedTrigger(context)) throw new Error('Untrusted watchdog trigger');
  const params = {owner: OWNER, repo: REPO, workflow_id: WORKFLOW};
  const clockParams = {owner: OWNER, repo: REPO, workflow_id: CLOCK_WORKFLOW};
  async function listRuns(p) {
    const runs = [];
    for (let page = 1; page <= 10; page++) {
      const {data} = await github.rest.actions.listWorkflowRuns({...p, per_page: 100, page,
        created: `>=${new Date(clock() - 24 * 60 * 60_000).toISOString()}`});
      if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid workflow history; no dispatch');
      runs.push(...data.workflow_runs);
      if (data.workflow_runs.length < 100) return runs;
    }
    throw new Error('Incomplete workflow history; no dispatch');
  }
  async function inspect() {
    const {data: workflow} = await github.rest.actions.getWorkflow(params);
    if (workflow.state !== 'active') return assessQueue(workflow, [], clock());
    return assessQueue(workflow, await listRuns(params), clock());
  }
  async function inspectClock() {
    const {data: workflow} = await github.rest.actions.getWorkflow(clockParams);
    if (workflow.state !== 'active') return assessClock(workflow, [], clock());
    return assessClock(workflow, await listRuns(clockParams), clock());
  }
  async function finish(result) {
    core.info(JSON.stringify(result));
    await core.summary.addHeading('Queue scheduling health').addRaw(JSON.stringify(result, null, 2)).write();
    return result;
  }
  // One open alert issue at a time; it is closed automatically on recovery so the
  // tracker mirrors current health without extra notification plumbing.
  async function alert(problems) {
    const {data: issues} = await github.rest.issues.listForRepo({owner: OWNER, repo: REPO, state: 'open', per_page: 50});
    const open = issues.filter(i => (i.body ?? '').includes(ALERT_MARKER) && !i.pull_request);
    if (problems.length) {
      const body = `${ALERT_MARKER}\n\nWatchdog could not recover scheduling on its own:\n\n${problems.map(p => `- ${p}`).join('\n')}\n\nSeen at ${new Date(clock()).toISOString()}.`;
      if (open.length) {
        await github.rest.issues.createComment({owner: OWNER, repo: REPO, issue_number: open[0].number, body});
        return {alerted: true, issue: open[0].number, created: false};
      }
      const {data: issue} = await github.rest.issues.create({owner: OWNER, repo: REPO, title: ALERT_TITLE, body});
      return {alerted: true, issue: issue.number, created: true};
    }
    for (const issue of open) {
      await github.rest.issues.createComment({owner: OWNER, repo: REPO, issue_number: issue.number,
        body: `${ALERT_MARKER}\n\nScheduling recovered; closing automatically.`});
      await github.rest.issues.update({owner: OWNER, repo: REPO, issue_number: issue.number, state: 'closed'});
    }
    return {alerted: false, closed: open.map(i => i.number)};
  }
  let plan = await inspect();
  let clockPlan = await inspectClock();
  const problems = [];
  if (plan.reason === 'queue-stopped-or-needs-approval') problems.push(`Review queue: ${plan.reason} (run ${plan.runId})`);
  if (clockPlan.clock === 'stopped') problems.push(`Internal review clock stopped manually or awaiting approval (run ${clockPlan.runId}) — restart it by hand or cancel the alert.`);
  // Dry runs inspect only: no dispatches and no alert issue writes.
  if (dryRun) return finish({...plan, clock: clockPlan, dryRun, dispatched: false});
  // A scheduled worker can appear between reads. It uses the same queue concurrency
  // and review cooldown even if it appears immediately after this second read.
  if (plan.dispatch) {
    plan = await inspect();
    if (plan.dispatch) {
      // No POST retry: a transport timeout may already have admitted the dispatch.
      await github.rest.actions.createWorkflowDispatch({...params, ref: 'main', inputs: {dry_run: 'false'}});
      plan = {...plan, dispatched: true, reason: 'recovery-dispatch-accepted'};
    }
  }
  if (clockPlan.dispatch) {
    clockPlan = await inspectClock();
    if (clockPlan.dispatch) {
      // Fresh chain: an empty parent_run_id starts a new self-dispatching tick.
      await github.rest.actions.createWorkflowDispatch({...clockParams, ref: 'main', inputs: {}});
      clockPlan = {...clockPlan, dispatched: true, clock: 'restarted'};
    }
  }
  const dispatched = Boolean(plan.dispatched || clockPlan.dispatched);
  return finish({...plan, clock: clockPlan, dryRun, dispatched, ...(await alert(problems))});
}
