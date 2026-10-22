const HOUR = 3600000;
const ACK_GRACE = 10 * 60000;
const RUNNING_GRACE = 2 * HOUR;
const QUARANTINE_GRACE = 2 * HOUR;      // un-acknowledged/stale requests retry after this silence
const REQUESTS_PER_HEAD = 3;            // posted requests per head before manual review is needed
const DRAFT_REFUSAL_COOLDOWN = 6 * HOUR; // spacing after the provider refused a draft review
const TRIGGER_ACK_WINDOW = 4 * 60000;   // in-run acknowledgement poll budget after a trigger
const ACK_POLL_MS = 15000;
const BOT = 'coderabbitai[bot]';
const OWNER = 'luvs01';
const MARKER = 'ocx-coderabbit-hourly';
const time = c => Date.parse(c.updated_at ?? c.created_at);
// Parse the provider's review control, never unrelated checkboxes (e.g. Autofix).
// Retain offsets so an edit changes only the selected checkbox character.
export function manualReviewCheckboxes(comment) {
  if (comment.user?.login !== BOT) return [];
  const boxes=[];
  for (const match of (comment.body??'').matchAll(/^[ \t]*(?:>[ \t]*)*-[ \t]+\[([ xX])\]([^\r\n]*)/gm)) {
    const label=match[2].replace(/<!--.*?-->/g,'').replace(/[\p{Extended_Pictographic}\uFE0F]/gu,'').trim();
    if (!/^(?:Trigger(?: a manual)? review|Check again to try again)$/i.test(label)) continue;
    const id=(match[2].match(/<!--\s*\{\s*"checkboxId"\s*:\s*"([^"\r\n]+)"\s*\}\s*-->/)??[])[1]??null;
    boxes.push({checked:match[1].toLowerCase()==='x',id,offset:match.index+match[0].indexOf('[')+1});
  }
  return boxes;
}
export function reviewTrigger(comments) {
  // A newer control surface supersedes the entire older surface, even when
  // CodeRabbit replaced its checkbox ID. Checked is distinct from absent.
  for (const comment of [...comments].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||Number(b.id??0)-Number(a.id??0))) {
    const boxes=manualReviewCheckboxes(comment);
    if(boxes.length)return {comment,box:boxes.find(b=>b.checked)??boxes[0],state:boxes.some(b=>b.checked)?'checked':'actionable'};
  }
  return null;
}
const PROGRESS=/review (?:in progress by coderabbit\.ai|triggered|started|queued)/gi;
const COMPLETION=/(?:full )?review (?:finished|completed)|already reviewed/gi;
const NEGATIVE=/draft[^.\n]{0,40}(?:not|not being|cannot be) review|(?:not|unable to|skipped)[^.\n]{0,40}draft|rate limited by coderabbit\.ai|review limit reached|rate limit exceeded|(?:could not|couldn't|unable to) start (?:this |the )?review|more reviews will be available in/gi;
function encodeBaseline(comments,head) {
  // Only provider IDs and relevant signal text, never full comments. The initial
  // marker makes fresh old-comment edits recoverable even if a later receipt
  // PATCH fails or its response is lost.
  const baseline=comments.filter(c=>c.user?.login===BOT&&Number.isSafeInteger(c.id)&&c.id>0).map(c=>({id:c.id,body:
    [PROGRESS,COMPLETION,NEGATIVE].flatMap(pattern=>[...(c.body??'').matchAll(pattern)].map(m=>m[0].toLowerCase())).join('\n')+
    (c.body?.includes(`change_assessment_commit:"${head}"`)&&/recent_review_start/.test(c.body)?`\nrecent_review_start change_assessment_commit:"${head}"`:'')}));
  if(baseline.length>1000||baseline.some(c=>c.body.length>5000))return null;
  return Buffer.from(JSON.stringify(baseline)).toString('base64url');
}
function decodeBaseline(body) {
  const encoded=body.match(/\bbaseline=([A-Za-z0-9_-]+)(?=\s)/)?.[1];
  if(!encoded||encoded.length>40000)return undefined;
  try {
    const baseline=JSON.parse(Buffer.from(encoded,'base64url').toString());
    if(Array.isArray(baseline)&&baseline.length<=1000&&baseline.every(c=>Number.isSafeInteger(c.id)&&c.id>0&&typeof c.body==='string'&&c.body.length<=5000))return baseline;
  } catch { /* malformed receipts never establish a baseline */ }
  return undefined;
}
function freshSignal(comment, pattern, pr, at, baseline) {
  if (comment.user?.login!==BOT || !Number.isFinite(time(comment)) || time(comment)<at) return false;
  const body=comment.body??'';
  const heads=[...body.matchAll(/change_assessment_commit:\s*"([0-9a-f]{7,40})"|\bhead=([0-9a-f]{7,40})/gi)].map(m=>(m[1]??m[2]).toLowerCase());
  if (heads.length && !heads.includes(pr.head.sha)) return false;
  const signals=[...body.matchAll(pattern)].map(m=>m[0].toLowerCase());
  if (!signals.length) return false;
  const old=baseline?.find(c=>c.id===comment.id);
  if (old) {
    const previous=[...(old.body??'').matchAll(pattern)].map(m=>m[0].toLowerCase());
    return signals.some(signal=>!previous.includes(signal));
  }
  // Across runs, a changed timestamp on an old comment cannot establish a new
  // generic signal. Exact-head completion metadata remains independently valid.
  return Date.parse(comment.created_at)>=at;
}
function triggerObservation(pr, comments, reviews, at, baseline, baselineReviews=[]) {
  const observation=(kind,source,sourceKind='comment')=>({kind,sourceKind,sourceId:source.id});
  const refusal=comments.find(c=>freshSignal(c,NEGATIVE,pr,at,baseline));
  if(refusal)return observation('trigger-refused',refusal);
  const headCompletion=c=>c.user?.login===BOT&&c.body?.includes(`change_assessment_commit:"${pr.head.sha}"`)&&/recent_review_start/.test(c.body);
  const review=reviews.find(r=>r.user?.login===BOT&&r.commit_id===pr.head.sha&&Date.parse(r.submitted_at)>=at&&!baselineReviews.some(old=>old.id&&old.id===r.id));
  if(review)return observation('trigger-completed',review,'review');
  const completion=comments.find(c=>headCompletion(c)&&time(c)>=at&&!baseline?.some(old=>old.id===c.id&&headCompletion(old)))??comments.find(c=>freshSignal(c,COMPLETION,pr,at,baseline));
  if(completion)return observation('trigger-completed',completion);
  const progress=comments.find(c=>freshSignal(c,PROGRESS,pr,at,baseline));
  if(progress)return observation('trigger-acknowledged',progress);
  return null;
}
export function triggerEvidence(...args) { return triggerObservation(...args)?.kind??null; }
export function isRequest(c) {
  // Only the authenticated owner consumes our local request budget. Old bot probes did not establish admission.
  return c.user?.login === OWNER && /^\s*@coderabbitai\s+(?:full\s+)?review\b/i.test(c.body ?? '');
}
export function isAdmission(c) {
  // A `trig` marker records a checkbox-toggle admission exactly like a posted
  // command records a request: both consume the hourly and per-head budgets.
  return isRequest(c) || markerInfo(c)?.trig === true;
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
  // Retain parsing for historical lift records; they do not admit a request.
  const liftRestored = /\blift-restored\b/.test(body);
  const confirmed=body.match(/\back=(progress|completed) evidence=(comment|review):([1-9]\d*) observed_at=(\S+)/);
  const validConfirmation=confirmed&&Number.isSafeInteger(Number(confirmed[3]))&&Number(confirmed[3])>0&&(confirmed[1]==='completed'||confirmed[2]==='comment');
  const confirmation=validConfirmation?{kind:confirmed[1],sourceKind:confirmed[2],sourceId:confirmed[3],observedAt:Date.parse(confirmed[4])}:null;
  return {head, lift: !liftRestored && /\blift\b/.test(body), liftRestored, trig: /(?:^|\s)trig(?:\s|$)/.test(body), rejected: /\btrig-rejected\b/.test(body), confirmation, baseline:decodeBaseline(body), at: Date.parse(c.created_at), id: c.id};
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
  const requests=ordered.filter(isAdmission);
  const tagged=requests.filter(c=>c.body.includes(`head=${pr.head.sha}`));
  const attempts=tagged.length;
  const manual=requests.filter(c=>!c.body.includes(MARKER)).at(-1);
  const request=[tagged.at(-1),manual].filter(Boolean).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
  const triggerMarker=markerInfo(request??{});
  const isTrigger=triggerMarker?.trig===true;
  const requestAt=request?Date.parse(request.created_at):0;
  const evidence=isTrigger?triggerEvidence(pr,comments,reviews,requestAt,triggerMarker.baseline):null;
  const saved=isTrigger?triggerMarker.confirmation:null;
  const confirmation=saved&&markerInfo(request).head===pr.head.sha&&Number.isFinite(saved.observedAt)&&saved.observedAt>=requestAt&&saved.observedAt<=now?saved:null;
  const started=bot.filter(c=>/review in progress by coderabbit\.ai/i.test(c.body??'')&&(!isTrigger||freshSignal(c,PROGRESS,pr,requestAt,triggerMarker.baseline))).sort((a,b)=>time(b)-time(a))[0];
  const completionAt=Math.max(0,
    ...reviews.filter(r=>r.user?.login===BOT&&r.commit_id===pr.head.sha&&r.submitted_at).map(r=>Date.parse(r.submitted_at)),
    ...bot.filter(c=>c.body?.includes(`change_assessment_commit:"${pr.head.sha}"`)&&/recent_review_start/.test(c.body)).map(time));
  // A completed review settles an older "in progress" marker; only a progress
  // comment newer than the completion still counts as running.
  if (evidence!=='trigger-refused'&&started && time(started) > completionAt) return {state:now-time(started)<RUNNING_GRACE?'running':'stale-running',since:time(started)};
  if (evidence!=='trigger-refused'&&completionAt) return {state:'completed'};
  if (evidence!=='trigger-refused'&&confirmation?.kind==='completed') return {state:'completed',requestId:request.id};
  const lastAttempt=ordered.filter(c=>isAdmission(c)||(markerInfo(c)?.rejected&&markerInfo(c)?.head===pr.head.sha)).at(-1);
  if(markerInfo(lastAttempt??{})?.rejected)return {state:'trigger-write-rejected',requestId:lastAttempt.id};
  // Do not treat unrelated PR updates as proof that a manual request was handled.
  if (request) {
    const at=Date.parse(request.created_at);
    if (!Number.isFinite(at)) throw new Error('Invalid review request timestamp');
    const subsequent=bot.filter(c=>time(c)>=at&&(!isTrigger||freshSignal(c,NEGATIVE,pr,at,triggerMarker.baseline)));
    if (evidence==='trigger-completed' || (!isTrigger&&request.body.includes(`head=${pr.head.sha}`) && subsequent.some(c=>/review finished|review completed|already reviewed/i.test(c.body??'')))) return {state:'completed',requestId:request.id};
    const refusals=subsequent.map(c=>{
      const limit=parseLimit(c);
      if (limit?.kind==='capacity') {
        const command=ordered.filter(x=>x.user?.login===OWNER&&/^\s*@coderabbitai\s+/i.test(x.body??'')&&Date.parse(x.created_at)<=Date.parse(c.created_at)).at(-1);
        // A quota-query reply is not evidence about review admission. A direct capacity
        // reply following this review command is an explicit refusal with retry timing.
        if((command?.id===request.id&&isRequest(command)) || (isTrigger&&(!command||Date.parse(command.created_at)<at)))return {...limit,kind:'refusal'};
      }
      return limit;
    }).filter(l=>l?.kind==='refusal').sort((a,b)=>b.at-a.at);
    if (refusals.length) {
      if (now<refusals[0].until) return {state:'rate-limited',requestId:request.id};
      // The per-head attempt budget applies to retried refusals as well; without
      // it a draft refused three times would request again after cooldown.
      if (attempts>=REQUESTS_PER_HEAD) return {state:'needs-manual',requestId:request.id,since:at};
      return {state:pr.draft?'draft-eligible':'eligible',requestId:request.id};
    }
    if (subsequent.some(draftRefusal)) {
      const until=at+DRAFT_REFUSAL_COOLDOWN;
      if (now<until) return {state:'draft-refused',requestId:request.id,until};
      if (attempts>=REQUESTS_PER_HEAD) return {state:'needs-manual',requestId:request.id,since:at};
      return {state:pr.draft?'draft-eligible':'eligible',requestId:request.id};
    }
    const acknowledged=confirmation?.kind==='progress'||evidence==='trigger-acknowledged'||reactions.some(r=>r.user?.login===BOT&&r.content==='eyes')||(!isTrigger&&subsequent.some(c=>/review (?:triggered|started|queued)/i.test(c.body??'')));
    if (acknowledged) {
      // A stale acknowledged request likely got dropped by the provider; retry within the per-head budget.
      const since=confirmation?.observedAt??at;
      if (now-since>=RUNNING_GRACE) return attempts<REQUESTS_PER_HEAD?{state:'retry-eligible',requestId:request.id,since}:{state:'needs-manual',requestId:request.id,since};
      return {state:'acknowledged',requestId:request.id,since};
    }
    if (now-at<ACK_GRACE) return {state:'awaiting-ack',requestId:request.id,since:at};
    // A marker is written before PATCH. It can represent an accepted or an
    // ambiguous write; silence/checkbox disappearance never authorizes a replay.
    if (isTrigger) return {state:'trigger-pending',requestId:request.id,since:at};
    if (attempts>=REQUESTS_PER_HEAD) return {state:'needs-manual',requestId:request.id,since:at};
    if (now-at>=QUARANTINE_GRACE) return {state:'retry-eligible',requestId:request.id,since:at};
    return {state:'quarantined-unacknowledged',requestId:request.id,since:at};
  }
  // updated_at also moves for comments, CI and bots. It is not code activity or
  // provider cooldown evidence; HEAD is independently rechecked before writes.
  return {state:pr.draft?'draft-eligible':'eligible'};
}
const SELECTABLE = new Set(['eligible','draft-eligible','retry-eligible']);
const BUSY = new Set(['running','acknowledged','awaiting-ack']);
export function decide(snapshots,recent,now) {
  const all=[...recent,...snapshots.flatMap(s=>s.comments)];
  const limit=latestLimit(all);
  const lastRequest=all.filter(isAdmission).reduce((n,c)=>{
    const at=Date.parse(c.created_at); if(!Number.isFinite(at))throw new Error('Invalid request timestamp');return Math.max(n,at);
  },0);
  const until=Math.max(lastRequest?lastRequest+HOUR:0,limit?.until??0);
  const states=snapshots.map(s=>{
    const state=analyze(s.pr,s.comments,s.reviews,s.reactions,now);
    const surface=SELECTABLE.has(state.state)?reviewTrigger(s.comments):null;
    if(surface?.state==='checked')return {number:s.pr.number,head:s.pr.head.sha,...state,state:'trigger-control-checked'};
    if(s.pr.draft&&SELECTABLE.has(state.state)&&!surface) return {number:s.pr.number,head:s.pr.head.sha,...state,state:'no-trigger-surface'};
    return {number:s.pr.number,head:s.pr.head.sha,...state};
  });
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
    await core.summary.addHeading('CodeRabbit queue status').addRaw(`${result.reason}; requests posted: ${result.requested}\n${result.nextEligibleAt?`Earliest eligibility: ${result.nextEligibleAt}\n`:''}${rows}`).write();
    return result;
  }
  const pulls=(await pages(github.rest.pulls.list,{owner,repo,state:'open',sort:'updated',direction:'asc'})).filter(p=>p.user?.login===owner);
  const repoComments=await recent();
  function globalCooldown(comments){
    const limit=latestLimit(comments);
    const last=comments.filter(isAdmission).reduce((n,c)=>Math.max(n,Date.parse(c.created_at)),0);
    return {until:Math.max(last?last+HOUR:0,limit?.until??0),limit};
  }
  // Global cooldown from repo-level evidence alone: while it holds there is no
  // per-PR sweep at all, so idle runs cost a handful of API calls instead of ~3N.
  const {until:globalUntil,limit:earlyLimit}=globalCooldown(repoComments);
  if(globalUntil>clock()){
    return finish({requested:0,reason:earlyLimit?.until===globalUntil?'provider-cooldown':'hourly-cooldown',nextEligibleAt:new Date(globalUntil).toISOString(),states:[],dryRun});
  }
  const snapshots=[];for(const pr of pulls)snapshots.push(await snapshot(pr));
  const plan=decide(snapshots,repoComments,clock());
  if(dryRun||!plan.selected)return finish({...plan,dryRun});
  // Recheck every candidate and global budget immediately before one external write.
  const fresh=[];
  for(const s of snapshots){const {data:pr}=await github.rest.pulls.get({owner,repo,pull_number:s.pr.number});fresh.push(await snapshot(pr));}
  const final=decide(fresh,await recent(),clock());
  if(final.selected!==plan.selected||fresh.find(s=>s.pr.number===plan.selected)?.pr.head.sha!==snapshots.find(s=>s.pr.number===plan.selected)?.pr.head.sha)return finish({...final,selected:null,reason:'state-changed-before-post'});
  const sel=fresh.find(s=>s.pr.number===final.selected);
  const pr=sel.pr;
  // Preferred admission: toggling the manual-review checkbox on CodeRabbit's
  // own skip-review comment. It works on drafts without touching PR state, so
  // no draft lift, marker pair, or GraphQL mutation is needed — one comment edit
  // plus the `trig` marker that keeps hourly/per-head admission accounting.
  const trigger=reviewTrigger(sel.comments);
  if(trigger?.state==='checked')return finish({...final,selected:null,reason:'trigger-control-checked'});
  if(trigger?.state==='actionable'){
    const baseline=encodeBaseline(sel.comments,pr.head.sha);
    if(!baseline||baseline.length>40000)return finish({...final,selected:null,reason:'baseline-too-large'});
    const {data:mk}=await github.rest.issues.createComment({owner,repo,issue_number:pr.number,body:`<!-- ${MARKER} trig head=${pr.head.sha} baseline=${baseline} -->`});
    const {comment,box}=trigger;
    const body=comment.body.slice(0,box.offset)+'x'+comment.body.slice(box.offset+1);
    let writeOutcome='submitted';
    try {
      await github.rest.issues.updateComment({owner,repo,comment_id:comment.id,body});
    } catch(error) {
      if([400,401,403,404,410,422].includes(error.status)) {
        // An explicit rejected PATCH is not a review admission. Persist that
        // distinction on our own marker; a failed accounting edit remains held.
        const rejected=`<!-- ${MARKER} trig-rejected head=${pr.head.sha} status=${error.status} -->`;
        let accounting='uncertain';
        try {
          await github.rest.issues.updateComment({owner,repo,comment_id:mk.id,body:rejected});
          const {data:recorded}=await github.rest.issues.getComment({owner,repo,comment_id:mk.id});
          if(recorded.body===rejected&&recorded.user?.login===owner)accounting='recorded';
        } catch { core.warning('Rejected checkbox write accounting is uncertain; keep the marker held'); }
        return finish({...final,requested:0,reason:'trigger-write-rejected',number:pr.number,commentId:mk.id,writeOutcome:'rejected',accounting});
      }
      // PATCH may have applied. Keep its admitted marker and inspect, never send
      // a second PATCH or fall back to another request after an uncertain write.
      writeOutcome='ambiguous';
      core.warning('Review checkbox write outcome is uncertain; inspecting without retry');
    }
    const deadline=clock()+TRIGGER_ACK_WINDOW;
    let ack=writeOutcome==='ambiguous'?'trigger-write-ambiguous':'trigger-ack-timeout', checkbox='unknown', confirmation='unconfirmed';
    while(true){
      let current=null;
      try { ({data:current}=await github.rest.issues.getComment({owner,repo,comment_id:comment.id})); }
      catch(error) { if(error.status!==404)throw error; }
      const currentBox=manualReviewCheckboxes(current??{}).find(b=>box.id?b.id===box.id:b.offset===box.offset);
      checkbox=currentBox?(currentBox.checked?'checked':'unchecked'):'missing';
      if(currentBox?.checked)writeOutcome='applied';
      const comments=await pages(github.rest.issues.listComments,{owner,repo,issue_number:pr.number});
      if(current&&!comments.some(c=>c.id===current.id))comments.push(current);
      const reviews=await pages(github.rest.pulls.listReviews,{owner,repo,pull_number:pr.number});
      const observation=triggerObservation(pr,comments,reviews,Date.parse(mk.created_at),sel.comments,sel.reviews);
      if(observation){
        const {data:observed}=await github.rest.pulls.get({owner,repo,pull_number:pr.number});
        if(observed.head.sha===pr.head.sha){
          ack=observation.kind;
          if(ack!=='trigger-refused') {
            // This receipt records an observed positive change, not a checkbox
            // edit timestamp. It survives the next run's loss of our baseline.
            confirmation='uncertain';
            if(/^[1-9]\d*$/.test(String(observation.sourceId))) {
              const kind=ack==='trigger-completed'?'completed':'progress';
              const receipt=`<!-- ${MARKER} trig head=${pr.head.sha} ack=${kind} evidence=${observation.sourceKind}:${observation.sourceId} observed_at=${new Date(clock()).toISOString()} baseline=${baseline} -->`;
              try { await github.rest.issues.updateComment({owner,repo,comment_id:mk.id,body:receipt}); }
              catch { core.warning('Positive evidence receipt write is uncertain; reading without retry'); }
              try {
                const {data:recorded}=await github.rest.issues.getComment({owner,repo,comment_id:mk.id});
                if(recorded.user?.login===owner&&recorded.body===receipt)confirmation='recorded';
              } catch { core.warning('Positive evidence receipt readback failed; keep the request pending'); }
            }
            if(confirmation!=='recorded')ack='trigger-confirmation-uncertain';
          }
          break;
        }
        ack='trigger-head-changed';break;
      }
      if(clock()>=deadline)break;
      await sleep(ACK_POLL_MS);
    }
    const reason=ack==='trigger-refused'?'posted-refused':ack==='trigger-completed'?'posted-completed':ack==='trigger-acknowledged'?'posted-acknowledged':'posted-awaiting-ack';
    return finish({...final,requested:1,reason,number:pr.number,commentId:mk.id,trigger:ack,checkbox,writeOutcome,confirmation});
  }
  if(pr.draft)return finish({...final,selected:null,reason:'no-trigger-surface'});
  const body=`@coderabbitai review\n\n<!-- ${MARKER} head=${pr.head.sha} -->`;
  // No automatic POST retry. Ambiguous outcomes are recovered from actual comments next run.
  const {data:posted}=await github.rest.issues.createComment({owner,repo,issue_number:pr.number,body});
  const {data:verified}=await github.rest.issues.getComment({owner,repo,comment_id:posted.id});
  if(verified.body!==body||verified.user?.login!==owner)throw new Error('Owner request readback mismatch');
  return finish({...final,requested:1,reason:'posted-awaiting-ack',number:pr.number,commentId:posted.id});
}
