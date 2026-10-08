const HOUR = 3600000;
const ACK_GRACE = 10 * 60000;
const RUNNING_GRACE = 2 * HOUR;
const QUARANTINE_GRACE = 2 * HOUR;      // un-acknowledged/stale requests retry after this silence
const REQUESTS_PER_HEAD = 3;            // posted requests per head before manual review is needed
const DRAFT_LIFT_COOLDOWN = 6 * HOUR;   // spacing between draft-lift attempts on one head
const LIFT_RESTORE_GRACE = 45 * 60000;  // a lifted PR left ready this long is converted back
const LIFT_ACK_WINDOW = 4 * 60000;      // in-run acknowledgement poll budget on a lifted PR
const LIFT_POLL_MS = 15000;
const BOT = 'coderabbitai[bot]';
const OWNER = 'luvs01';
const MARKER = 'ocx-coderabbit-hourly';
const time = c => Date.parse(c.updated_at ?? c.created_at);
export function isRequest(c) {
  // Only the authenticated owner consumes our local request budget. Old bot probes did not establish admission.
  return c.user?.login === OWNER && /^\s*@coderabbitai\s+(?:full\s+)?review\b/i.test(c.body ?? '');
}
export function parseLimit(c) {
  if (c.user?.login !== BOT) return null;
  const body=(c.body ?? '').replace(/\*/g,'');
  const refusal=/rate limited by coderabbit\.ai|review limit reached|rate limit exceeded|(?:could not|couldn't|unable to) start (?:this |the )?review/i.test(body);
  const capacity=/more reviews will be available in/i.test(body);
  if (!refusal && !capacity) return null;
  const at=time(c);
  if (!Number.isFinite(at)) throw new Error('Invalid provider limit timestamp');
  const values=[];
  for (const m of body.matchAll(/(?:more reviews will be available in|please wait|try again in|retry (?:in|after))\s+/gi)) {
    const clause=body.slice(m.index+m[0].length,m.index+m[0].length+240).split(/\n|\.(?:\s|$)/)[0]; let ms=0, found=false;
    for (const v of clause.matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      found=true; const unit=v[2].toLowerCase();
      ms+=Number(v[1])*(unit.startsWith('d')?24*HOUR:unit.startsWith('h')?HOUR:unit.startsWith('m')?60000:1000);
    }
    if (found && Number.isFinite(ms)) values.push(ms);
  }
  // Unknown refusal timing stays conservative; do not replace a valid short delay with an hour.
  const delay=values.length?Math.max(...values):HOUR;
  return {at,until:at+delay,kind:refusal?'refusal':'capacity',fallback:values.length===0};
}
export function rateLimitUntil(c) { return parseLimit(c)?.until ?? 0; }
export function latestLimit(comments) {
  return comments.map(parseLimit).filter(Boolean).sort((a,b)=>b.at-a.at||b.until-a.until)[0] ?? null;
}
export function markerInfo(c) {
  const body = c.body ?? '';
  if (c.user?.login !== OWNER || !body.includes(MARKER)) return null;
  const head = (body.match(/head=([0-9a-f]{7,40})/i) ?? [])[1]?.toLowerCase() ?? null;
  return {head, lift: /\blift\b/.test(body), at: Date.parse(c.created_at)};
}
export function draftRefusal(c) {
  if (c.user?.login !== BOT) return false;
  const body = c.body ?? '';
  return /draft[^.\n]{0,40}(?:not|not being|cannot be) review|(?:not|unable to|skipped)[^.\n]{0,40}draft/i.test(body);
}
export function analyze(pr, comments, reviews, reactions=[], now=Date.now()) {
  if (pr.state!=='open') return {state:'excluded',exclusionReason:'not-open'};
  if (pr.user?.login!==OWNER) return {state:'excluded',exclusionReason:'foreign-author'};
  const ordered=[...comments].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
  const control=ordered.filter(c=>c.user?.login===OWNER&&/^\s*@coderabbitai\s+(pause|resume)\b/i.test(c.body??'')).at(-1);
  if (/@coderabbitai\s+(?:ignore|pause)\b/i.test(pr.body??'') || (control&&/@coderabbitai\s+pause\b/i.test(control.body))) return {state:'paused'};
  const bot=comments.filter(c=>c.user?.login===BOT);
  const started=bot.filter(c=>/review in progress by coderabbit\.ai/i.test(c.body??'')).sort((a,b)=>time(b)-time(a))[0];
  const completionAt=Math.max(0,
    ...reviews.filter(r=>r.user?.login===BOT&&r.commit_id===pr.head.sha&&r.submitted_at).map(r=>Date.parse(r.submitted_at)),
    ...bot.filter(c=>c.body?.includes(`change_assessment_commit:"${pr.head.sha}"`)&&/recent_review_start/.test(c.body)).map(time));
  // A completed review settles an older "in progress" marker; only a progress
  // comment newer than the completion still counts as running.
  if (started && time(started) > completionAt) return {state:now-time(started)<RUNNING_GRACE?'running':'stale-running',since:time(started)};
  if (completionAt) return {state:'completed'};
  const requests=ordered.filter(isRequest);
  const tagged=requests.filter(c=>c.body.includes(`head=${pr.head.sha}`));
  const attempts=tagged.length;
  const manual=requests.filter(c=>!c.body.includes(MARKER)).at(-1);
  // Do not treat unrelated PR updates as proof that a manual request was handled.
  const request=[tagged.at(-1),manual].filter(Boolean).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
  if (request) {
    const at=Date.parse(request.created_at);
    if (!Number.isFinite(at)) throw new Error('Invalid review request timestamp');
    const subsequent=bot.filter(c=>time(c)>=at);
    if (request.body.includes(`head=${pr.head.sha}`) && subsequent.some(c=>/review finished|review completed|already reviewed/i.test(c.body??''))) return {state:'completed',requestId:request.id};
    const refusals=subsequent.map(c=>{
      const limit=parseLimit(c);
      if (limit?.kind==='capacity') {
        const command=ordered.filter(x=>x.user?.login===OWNER&&/^\s*@coderabbitai\s+/i.test(x.body??'')&&Date.parse(x.created_at)<=Date.parse(c.created_at)).at(-1);
        // A quota-query reply is not evidence about review admission. A direct capacity
        // reply following this review command is an explicit refusal with retry timing.
        if(command?.id===request.id&&isRequest(command))return {...limit,kind:'refusal'};
      }
      return limit;
    }).filter(l=>l?.kind==='refusal').sort((a,b)=>b.at-a.at);
    if (refusals.length) return {state:now<refusals[0].until?'rate-limited':'eligible',requestId:request.id};
    if (subsequent.some(draftRefusal)) {
      const until=at+DRAFT_LIFT_COOLDOWN;
      return now<until?{state:'draft-refused',requestId:request.id,until}:{state:pr.draft?'draft-eligible':'eligible',requestId:request.id};
    }
    const acknowledged=reactions.some(r=>r.user?.login===BOT&&r.content==='eyes')||subsequent.some(c=>/review (?:triggered|started|queued)/i.test(c.body??''));
    if (acknowledged) {
      // A stale acknowledged request likely got dropped by the provider; retry within the per-head budget.
      if (now-at>=RUNNING_GRACE) return attempts<REQUESTS_PER_HEAD?{state:'retry-eligible',requestId:request.id,since:at}:{state:'needs-manual',requestId:request.id,since:at};
      return {state:'acknowledged',requestId:request.id,since:at};
    }
    if (now-at<ACK_GRACE) return {state:'awaiting-ack',requestId:request.id,since:at};
    if (attempts>=REQUESTS_PER_HEAD) return {state:'needs-manual',requestId:request.id,since:at};
    if (now-at>=QUARANTINE_GRACE) return {state:'retry-eligible',requestId:request.id,since:at};
    return {state:'quarantined-unacknowledged',requestId:request.id,since:at};
  }
  const changed=Date.parse(pr.updated_at);
  if (!Number.isFinite(changed)) throw new Error('Invalid PR timestamp');
  if (now-changed<15*60000) return {state:'recent-activity'};
  if (pr.draft) {
    const headSha=(pr.head.sha??'').toLowerCase();
    const lifts=comments.map(markerInfo).filter(m=>m?.lift&&m.head===headSha).sort((a,b)=>b.at-a.at);
    if (lifts.length>=REQUESTS_PER_HEAD) return {state:'needs-manual'};
    // A marker without a following request means the last lift failed before posting.
    if (lifts[0] && now-lifts[0].at<DRAFT_LIFT_COOLDOWN) return {state:'draft-lift-failed',until:lifts[0].at+DRAFT_LIFT_COOLDOWN};
    return {state:'draft-eligible'};
  }
  return {state:'eligible'};
}
const SELECTABLE = new Set(['eligible','draft-eligible','retry-eligible']);
const BUSY = new Set(['running','acknowledged','awaiting-ack']);
export function decide(snapshots,recent,now) {
  const all=[...recent,...snapshots.flatMap(s=>s.comments)];
  const limit=latestLimit(all);
  const lastRequest=all.filter(isRequest).reduce((n,c)=>{
    const at=Date.parse(c.created_at); if(!Number.isFinite(at))throw new Error('Invalid request timestamp');return Math.max(n,at);
  },0);
  const until=Math.max(lastRequest?lastRequest+HOUR:0,limit?.until??0);
  const states=snapshots.map(s=>({number:s.pr.number,head:s.pr.head.sha,...analyze(s.pr,s.comments,s.reviews,s.reactions,now)}));
  if(until>now)return {requested:0,reason:limit?.until===until?'provider-cooldown':'hourly-cooldown',nextEligibleAt:new Date(until).toISOString(),states};
  const busy=states.find(s=>BUSY.has(s.state));
  if(busy)return {requested:0,reason:busy.state,number:busy.number,states};
  const next=states.find(s=>SELECTABLE.has(s.state));
  return {requested:0,reason:next?'eligible':'no-eligible-head',selected:next?.number??null,states};
}
export async function run({github,context,core,dryRun=true,clock=()=>Date.now(),sleep=(ms)=>new Promise(r=>setTimeout(r,ms))}) {
  if(context.repo.owner!==OWNER||context.repo.repo!=='opencodex-automation')throw new Error('Controller-only workflow');
  const owner=OWNER, repo='opencodex';
  async function pages(method,params,cap=10){
    const out=[];for(let page=1;page<=cap;page++){
      const {data}=await method({...params,per_page:100,page});if(!Array.isArray(data))throw new Error('Invalid paginated response');out.push(...data);if(data.length<100)return out;
    }throw new Error('Pagination cap reached; no request');
  }
  async function snapshot(pr){
    // Keep excluded PRs visible without fetching review history or admitting them.
    if(analyze(pr,[],[],[],clock()).state==='excluded')return {pr,comments:[],reviews:[],reactions:[]};
    const comments=await pages(github.rest.issues.listComments,{owner,repo,issue_number:pr.number});
    const reviews=await pages(github.rest.pulls.listReviews,{owner,repo,pull_number:pr.number});
    const pending=analyze(pr,comments,reviews,[],clock());let reactions=[];
    if(pending.requestId&&['awaiting-ack','quarantined-unacknowledged','retry-eligible','needs-manual'].includes(pending.state))reactions=await pages(github.rest.reactions.listForIssueComment,{owner,repo,comment_id:pending.requestId});
    return {pr,comments,reviews,reactions};
  }
  async function recent(){return pages(github.rest.issues.listCommentsForRepo,{owner,repo,since:new Date(clock()-24*HOUR).toISOString(),sort:'created',direction:'desc'},20);}
  async function finish(result){
    core.info(JSON.stringify(result));
    const rows=(result.states??[]).map(s=>`#${s.number}: ${s.state}${s.exclusionReason?` (${s.exclusionReason})`:''}`).join('\n');
    await core.summary.addHeading('CodeRabbit queue status').addRaw(`${result.reason}; requests posted: ${result.requested}\n${result.nextEligibleAt?`Earliest eligibility: ${result.nextEligibleAt}\n`:''}${result.restored?.length?`Draft state restored: ${result.restored.map(n=>'#'+n).join(', ')}\n`:''}${rows}`).write();
    return result;
  }
  // Draft bypass: temporarily mark a draft PR ready so CodeRabbit accepts the
  // review command, then convert it back once the outcome is known. The lift
  // marker comment is written BEFORE the state change so a later run can always
  // tell "we lifted this" apart from "the author marked it ready".
  async function setDraft(pr,draft){
    const query=draft
      ?'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}'
      :'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}';
    const res=await github.graphql(query,{id:pr.node_id});
    const node=res?.convertPullRequestToDraft?.pullRequest ?? res?.markPullRequestReadyForReview?.pullRequest;
    if(!node||node.isDraft!==draft)throw new Error('Draft mutation was not applied');
  }
  const pulls=(await pages(github.rest.pulls.list,{owner,repo,state:'open',sort:'updated',direction:'asc'})).filter(p=>p.user?.login===owner);
  const repoComments=await recent();
  // Ready state is a PR-level flag, not head-scoped: key lift markers by issue
  // number so a lifted PR is restored even after new commits move its head.
  const liftMarkers=new Map();
  for(const c of repoComments){const m=markerInfo(c);const num=Number(c.issue_url?.split('/').pop());if(m?.lift&&Number.isFinite(num)&&m.at<=clock()+60_000)liftMarkers.set(num,Math.max(m.at,liftMarkers.get(num)??0));}
  const restoreCandidates=pulls.filter(p=>!p.draft&&liftMarkers.has(p.number));
  // Global cooldown from repo-level evidence alone: while it holds there is no
  // per-PR sweep at all, so idle runs cost two API calls instead of ~3N.
  const earlyLimit=latestLimit(repoComments);
  const earlyLast=repoComments.filter(isRequest).reduce((n,c)=>Math.max(n,Date.parse(c.created_at)),0);
  const globalUntil=Math.max(earlyLast?earlyLast+HOUR:0,earlyLimit?.until??0);
  async function restoreLifted(snapshots=[]){
    const restored=[];
    for(const pr of restoreCandidates){
      const markerAt=liftMarkers.get(pr.number);
      const snap=snapshots.find(s=>s.pr.number===pr.number)??await snapshot(pr);
      const st=analyze(pr,snap.comments,snap.reviews,snap.reactions,clock());
      // Terminal enough to restore: the review settled, the request was refused,
      // or the marker is simply too old to wait any longer.
      const terminal=['completed','rate-limited','draft-refused','acknowledged','running','needs-manual'].includes(st.state);
      if(terminal||clock()-markerAt>=LIFT_RESTORE_GRACE){
        try{await setDraft(pr,true);restored.push(pr.number);}catch(e){core.warning(`Draft restore failed for #${pr.number}: ${e.message??e}`);}
      }
    }
    return restored;
  }
  if(globalUntil>clock()){
    const restored=await restoreLifted();
    return finish({requested:0,reason:earlyLimit?.until===globalUntil?'provider-cooldown':'hourly-cooldown',nextEligibleAt:new Date(globalUntil).toISOString(),states:[],restored,dryRun});
  }
  const snapshots=[];for(const pr of pulls)snapshots.push(await snapshot(pr));
  let plan=decide(snapshots,repoComments,clock());
  const restored=await restoreLifted(snapshots);
  if(restored.length){
    for(const n of restored){
      const {data:fresh}=await github.rest.pulls.get({owner,repo,pull_number:n});
      const i=snapshots.findIndex(s=>s.pr.number===n);
      if(i>=0)snapshots[i]=await snapshot(fresh);
    }
    plan=decide(snapshots,repoComments,clock());
  }
  if(dryRun||!plan.selected)return finish({...plan,restored,dryRun});
  const target=snapshots.find(s=>s.pr.number===plan.selected).pr;
  if(target.draft){
    // Lift -> request -> poll the acknowledgement -> restore. A crash after the
    // marker leaves the PR ready, which the next run (or the repo's own draft
    // gate) converts back; a crash before the marker never touches the PR.
    await github.rest.issues.createComment({owner,repo,issue_number:target.number,body:`<!-- ${MARKER} lift head=${target.head.sha} -->`});
    liftMarkers.set(target.number,clock());
    try{
      await setDraft(target,false);
      const {data:ready}=await github.rest.pulls.get({owner,repo,pull_number:target.number});
      if(ready.draft)return finish({...plan,selected:null,reason:'lift-blocked',restored});
    }catch(e){return finish({...plan,selected:null,reason:`lift-failed: ${e.message??e}`,restored});}
    const body=`@coderabbitai review\n\n<!-- ${MARKER} head=${target.head.sha} -->`;
    const {data:posted}=await github.rest.issues.createComment({owner,repo,issue_number:target.number,body});
    const {data:verified}=await github.rest.issues.getComment({owner,repo,comment_id:posted.id});
    if(verified.body!==body||verified.user?.login!==owner)throw new Error('Owner request readback mismatch');
    let lift='lift-ack-timeout';
    const deadline=clock()+LIFT_ACK_WINDOW;
    while(clock()<deadline){
      await sleep(LIFT_POLL_MS);
      const {data:reactions}=await github.rest.reactions.listForIssueComment({owner,repo,comment_id:posted.id});
      if(reactions.some(r=>r.user?.login===BOT&&r.content==='eyes')){lift='lift-acknowledged';break;}
      const comments=await pages(github.rest.issues.listComments,{owner,repo,issue_number:target.number});
      const subsequent=comments.filter(c=>c.user?.login===BOT&&time(c)>=Date.parse(posted.created_at)-5000);
      if(subsequent.some(c=>/review (?:in progress by coderabbit\.ai|triggered|started|queued)/i.test(c.body??''))){lift='lift-acknowledged';break;}
      if(subsequent.some(c=>parseLimit(c)||draftRefusal(c))){lift='lift-refused';break;}
    }
    try{await setDraft(target,true);}catch(e){core.warning(`Draft restore after lift failed for #${target.number}: ${e.message??e}`);}
    return finish({...plan,requested:1,reason:'posted-awaiting-ack',number:target.number,commentId:posted.id,lift,restored});
  }
  // Recheck every candidate and global budget immediately before one external write.
  const fresh=[];
  for(const s of snapshots){const {data:pr}=await github.rest.pulls.get({owner,repo,pull_number:s.pr.number});fresh.push(await snapshot(pr));}
  const final=decide(fresh,await recent(),clock());
  if(final.selected!==plan.selected||fresh.find(s=>s.pr.number===plan.selected)?.pr.head.sha!==snapshots.find(s=>s.pr.number===plan.selected)?.pr.head.sha)return finish({...final,selected:null,reason:'state-changed-before-post',restored});
  const pr=fresh.find(s=>s.pr.number===final.selected).pr;
  if(pr.draft)return finish({...final,selected:null,reason:'state-changed-before-post',restored});
  const body=`@coderabbitai review\n\n<!-- ${MARKER} head=${pr.head.sha} -->`;
  // No automatic POST retry. Ambiguous outcomes are recovered from actual comments next run.
  const {data:posted}=await github.rest.issues.createComment({owner,repo,issue_number:pr.number,body});
  const {data:verified}=await github.rest.issues.getComment({owner,repo,comment_id:posted.id});
  if(verified.body!==body||verified.user?.login!==owner)throw new Error('Owner request readback mismatch');
  return finish({...final,requested:1,reason:'posted-awaiting-ack',number:pr.number,commentId:posted.id,restored});
}
