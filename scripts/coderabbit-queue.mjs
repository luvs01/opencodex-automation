const HOUR = 3600000;
const ACK_GRACE = 10 * 60000;
const RUNNING_GRACE = 2 * HOUR;
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
export function analyze(pr, comments, reviews, reactions=[], now=Date.now()) {
  if (pr.state!=='open'||pr.draft||pr.user?.login!==OWNER) return {state:'excluded'};
  const ordered=[...comments].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
  const control=ordered.filter(c=>c.user?.login===OWNER&&/^\s*@coderabbitai\s+(pause|resume)\b/i.test(c.body??'')).at(-1);
  if (/@coderabbitai\s+(?:ignore|pause)\b/i.test(pr.body??'') || (control&&/@coderabbitai\s+pause\b/i.test(control.body))) return {state:'paused'};
  const bot=comments.filter(c=>c.user?.login===BOT);
  const started=bot.filter(c=>/review in progress by coderabbit\.ai/i.test(c.body??'')).sort((a,b)=>time(b)-time(a))[0];
  if (started) return {state:now-time(started)<RUNNING_GRACE?'running':'stale-running',since:time(started)};
  if (reviews.some(r=>r.user?.login===BOT&&r.commit_id===pr.head.sha&&r.submitted_at)) return {state:'completed'};
  if (bot.some(c=>c.body?.includes(`change_assessment_commit:"${pr.head.sha}"`)&&/recent_review_start/.test(c.body))) return {state:'completed'};
  const requests=ordered.filter(isRequest);
  const tagged=requests.filter(c=>c.body.includes(`head=${pr.head.sha}`)).at(-1);
  const manual=requests.filter(c=>!c.body.includes(MARKER)).at(-1);
  // Do not treat unrelated PR updates as proof that a manual request was handled.
  const request=[tagged,manual].filter(Boolean).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
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
    const acknowledged=reactions.some(r=>r.user?.login===BOT&&r.content==='eyes')||subsequent.some(c=>/review (?:triggered|started|queued)/i.test(c.body??''));
    if (acknowledged) return {state:now-at<RUNNING_GRACE?'acknowledged':'stale-running',requestId:request.id,since:at};
    return {state:now-at<ACK_GRACE?'awaiting-ack':'quarantined-unacknowledged',requestId:request.id,since:at};
  }
  const changed=Date.parse(pr.updated_at);
  if (!Number.isFinite(changed)) throw new Error('Invalid PR timestamp');
  return {state:now-changed<15*60000?'recent-activity':'eligible'};
}
export function decide(snapshots,recent,now) {
  const all=[...recent,...snapshots.flatMap(s=>s.comments)];
  const limit=latestLimit(all);
  const lastRequest=all.filter(isRequest).reduce((n,c)=>{
    const at=Date.parse(c.created_at); if(!Number.isFinite(at))throw new Error('Invalid request timestamp');return Math.max(n,at);
  },0);
  const until=Math.max(lastRequest?lastRequest+HOUR:0,limit?.until??0);
  const states=snapshots.map(s=>({number:s.pr.number,head:s.pr.head.sha,...analyze(s.pr,s.comments,s.reviews,s.reactions,now)}));
  if(until>now)return {requested:0,reason:limit?.until===until?'provider-cooldown':'hourly-cooldown',nextEligibleAt:new Date(until).toISOString(),states};
  const busy=states.find(s=>['running','acknowledged','awaiting-ack'].includes(s.state));
  if(busy)return {requested:0,reason:busy.state,number:busy.number,states};
  const next=states.find(s=>s.state==='eligible');
  return {requested:0,reason:next?'eligible':'no-eligible-head',selected:next?.number??null,states};
}
export async function run({github,context,core,dryRun=true,clock=()=>Date.now()}) {
  if(context.repo.owner!==OWNER||context.repo.repo!=='opencodex-automation')throw new Error('Controller-only workflow');
  const owner=OWNER, repo='opencodex';
  async function pages(method,params,cap=10){
    const out=[];for(let page=1;page<=cap;page++){
      const {data}=await method({...params,per_page:100,page});if(!Array.isArray(data))throw new Error('Invalid paginated response');out.push(...data);if(data.length<100)return out;
    }throw new Error('Pagination cap reached; no request');
  }
  async function snapshot(pr){
    const comments=await pages(github.rest.issues.listComments,{owner,repo,issue_number:pr.number});
    const reviews=await pages(github.rest.pulls.listReviews,{owner,repo,pull_number:pr.number});
    const pending=analyze(pr,comments,reviews,[],clock());let reactions=[];
    if(pending.requestId&&['awaiting-ack','quarantined-unacknowledged'].includes(pending.state))reactions=await pages(github.rest.reactions.listForIssueComment,{owner,repo,comment_id:pending.requestId});
    return {pr,comments,reviews,reactions};
  }
  async function recent(){return pages(github.rest.issues.listCommentsForRepo,{owner,repo,since:new Date(clock()-24*HOUR).toISOString(),sort:'created',direction:'desc'},20);}
  async function finish(result){
    core.info(JSON.stringify(result));
    const rows=(result.states??[]).map(s=>`#${s.number}: ${s.state}`).join('\n');
    await core.summary.addHeading('CodeRabbit queue status').addRaw(`${result.reason}; requests posted: ${result.requested}\n${result.nextEligibleAt?`Earliest eligibility: ${result.nextEligibleAt}\n`:''}${rows}`).write();
    return result;
  }
  const pulls=(await pages(github.rest.pulls.list,{owner,repo,state:'open',sort:'updated',direction:'asc'})).filter(p=>p.user?.login===owner&&!p.draft);
  const snapshots=[];for(const pr of pulls)snapshots.push(await snapshot(pr));
  let plan=decide(snapshots,await recent(),clock());
  if(dryRun||!plan.selected)return finish({...plan,dryRun});
  // Recheck every candidate and global budget immediately before one external write.
  const fresh=[];
  for(const s of snapshots){const {data:pr}=await github.rest.pulls.get({owner,repo,pull_number:s.pr.number});fresh.push(await snapshot(pr));}
  const final=decide(fresh,await recent(),clock());
  if(final.selected!==plan.selected||fresh.find(s=>s.pr.number===plan.selected)?.pr.head.sha!==snapshots.find(s=>s.pr.number===plan.selected)?.pr.head.sha)return finish({...final,selected:null,reason:'state-changed-before-post'});
  const pr=fresh.find(s=>s.pr.number===final.selected).pr;
  const body=`@coderabbitai review\n\n<!-- ${MARKER} head=${pr.head.sha} -->`;
  // No automatic POST retry. Ambiguous outcomes are recovered from actual comments next run.
  const {data:posted}=await github.rest.issues.createComment({owner,repo,issue_number:pr.number,body});
  const {data:verified}=await github.rest.issues.getComment({owner,repo,comment_id:posted.id});
  if(verified.body!==body||verified.user?.login!==owner)throw new Error('Owner request readback mismatch');
  return finish({...final,requested:1,reason:'posted-awaiting-ack',number:pr.number,commentId:posted.id});
}
