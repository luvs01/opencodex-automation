import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isRequest,isAdmission,markerInfo,parseLimit,latestLimit,analyze,decide,run,manualReviewCheckboxes,triggerEvidence} from '../scripts/coderabbit-queue.mjs';
const H=3600000, now=Date.parse('2026-09-29T12:20:00Z'), stamp=(age)=>new Date(now-age).toISOString();
const pr={number:1,state:'open',draft:false,user:{login:'luvs01'},head:{sha:'a'.repeat(40)},updated_at:stamp(2*H),body:''};
const bot=(body,age=0)=>({body,user:{login:'coderabbitai[bot]',type:'Bot'},created_at:stamp(age),updated_at:stamp(age)});
const req=(age=2*H,head=pr.head.sha)=>({id:123,body:`@coderabbitai review\n<!-- ocx-coderabbit-hourly head=${head} -->`,user:{login:'luvs01',type:'User'},created_at:stamp(age),updated_at:stamp(age)});
const snap=(p=pr,comments=[],reviews=[],reactions=[])=>({pr:p,comments,reviews,reactions});
const state=(comments=[],p=pr,reviews=[],reactions=[])=>analyze(p,comments,reviews,reactions,now).state;
test('actual availability reply preserves 21 minutes',()=>assert.equal(parseLimit(bot('More reviews will be available in 21 minutes.')).until,now+21*60000));
test('bold compound wait and decimals',()=>assert.equal(parseLimit(bot('Review limit reached. Please wait **1.5 hours and 2 minutes 5 seconds**.')).until,now+1.5*H+125000));
test('abbreviated durations',()=>assert.equal(parseLimit(bot('Rate limit exceeded. Retry after ~2 h 3 min 4 sec.')).until,now+2*H+184000));
test('zero capacity delay is allowed',()=>assert.equal(parseLimit(bot('More reviews will be available in 0 seconds.')).until,now));
test('malformed refusal uses anchored conservative hour',()=>assert.equal(parseLimit(bot('Review limit reached. Please wait a while.',60000)).until,now-60000+H));
test('non-bot cannot set provider cooldown',()=>assert.equal(parseLimit({...bot('More reviews will be available in 90 days.'),user:{login:'stranger'}}),null));
test('longest explicit hint retained',()=>assert.equal(parseLimit(bot('Review limit reached. Try again in 2 minutes. Please wait 1 hour.')).until,now+H));
test('new availability supersedes older warning',()=>assert.equal(latestLimit([bot('Review limit reached. Please wait 12 hours.',H),bot('More reviews will be available in 21 minutes.')]).until,now+21*60000));
test('bad timestamps fail closed',()=>assert.throws(()=>parseLimit({...bot('Review limit reached.'),updated_at:'garbled'})));
test('legacy bot probe does not consume owner budget',()=>assert.equal(isRequest({...req(),user:{login:'github-actions[bot]'}}),false));
test('manual owner review consumes budget; quota query does not',()=>{assert.equal(isRequest(req()),true);assert.equal(isRequest({...req(),body:'@coderabbitai rate limit'}),false)});
test('eligible quiet head',()=>assert.equal(state(),'eligible'));
test('closed foreign author excluded',()=>{for(const p of [{...pr,state:'closed'},{...pr,user:{login:'other'}}])assert.equal(state([],p),'excluded')});
test('pause preserved despite fresh refusal',()=>assert.equal(state([bot('Review limit reached.')],{...pr,body:'@coderabbitai ignore'}),'paused'));
test('paused owner command preserved and resume restores',()=>{const pause={...req(),body:'@coderabbitai pause'};assert.equal(state([pause]),'paused');assert.equal(state([pause,{...req(1000),body:'@coderabbitai resume'}]),'eligible')});
test('PR updated_at from code or comments adds no arbitrary hold',()=>{
  assert.equal(state([],{...pr,updated_at:stamp(60000)}),'eligible');
  assert.equal(state([],{...pr,draft:true,updated_at:stamp(0)}),'draft-eligible');
});
test('exact head review completes',()=>assert.equal(state([],pr,[{user:{login:'coderabbitai[bot]'},commit_id:pr.head.sha,submitted_at:stamp(1000)}]),'completed'));
test('explicit current processing takes precedence over earlier completed review',()=>assert.equal(state([bot('<!-- review in progress by coderabbit.ai -->')],pr,[{user:{login:'coderabbitai[bot]'},commit_id:pr.head.sha,submitted_at:stamp(H)}]),'running'));
test('walkthrough head marker completes',()=>assert.equal(state([bot(`<!-- recent_review_start --><!-- change_assessment_commit:"${pr.head.sha}" -->`)]),'completed'));
test('first ten minutes await acknowledgement',()=>assert.equal(state([req(5*60000)]),'awaiting-ack'));
test('unacknowledged request quarantined, not repeated',()=>assert.equal(state([req(70*60000)]),'quarantined-unacknowledged'));
test('eyes reaction acknowledges',()=>assert.equal(state([req(15*60000)],pr,[],[{user:{login:'coderabbitai[bot]'},content:'eyes'}]),'acknowledged'));
test('foreign reaction not acknowledged',()=>assert.equal(state([req(15*60000)],pr,[],[{user:{login:'stranger'},content:'eyes'}]),'quarantined-unacknowledged'));
test('new head recovers tagged quarantine',()=>assert.equal(state([req(2*H,'b'.repeat(40))]),'eligible'));
test('explicit refusal retries after stated time',()=>assert.equal(state([req(2*H),bot('Review limit reached. Please wait 10 minutes.',30*60000)]),'eligible'));
test('quota-query answer is not review acknowledgement',()=>assert.equal(state([req(2*H),{...req(1000),id:124,body:'@coderabbitai rate limit'},bot('More reviews will be available in 21 minutes.')]),'retry-eligible'));
test('capacity reply to review is explicit refusal',()=>assert.equal(state([req(20*60000),bot('More reviews will be available in 21 minutes.')]),'rate-limited'));
test('expired direct capacity refusal permits recovery',()=>assert.equal(state([req(2*H),bot('More reviews will be available in 21 minutes.',H)]),'eligible'));
test('manual unknown outcome is not hidden by PR updatedAt',()=>assert.equal(state([{...req(20*60000),body:'@coderabbitai review'}],{...pr,updated_at:stamp(1000)}),'quarantined-unacknowledged'));
test('fresh and stale processing distinguished',()=>{assert.equal(state([bot('<!-- review in progress by coderabbit.ai -->',1000)]),'running');assert.equal(state([bot('<!-- review in progress by coderabbit.ai -->',3*H)]),'stale-running')});
test('owner one-hour budget and provider delay both honored',()=>{const p=decide([snap()],[req(20*60000),bot('More reviews will be available in 21 minutes.')],now);assert.equal(p.reason,'hourly-cooldown');assert.equal(p.nextEligibleAt,new Date(now+40*60000).toISOString())});
test('old bot probe ignored while real quota still gates',()=>{const p=decide([snap()],[{...req(1000),user:{login:'github-actions[bot]'}},bot('More reviews will be available in 21 minutes.')],now);assert.equal(p.reason,'provider-cooldown');assert.equal(p.nextEligibleAt,new Date(now+21*60000).toISOString())});
test('one quarantined head does not freeze other PRs',()=>{const p=decide([snap(pr,[req(70*60000)]),snap({...pr,number:2})],[],now);assert.equal(p.selected,2)});
test('unacknowledged head retries inside the per-head budget',()=>{
  assert.equal(state([req(3*H)]),'retry-eligible');
  assert.equal(decide([snap(pr,[req(3*H)])],[],now).selected,1);
});
test('per-head request budget caps automatic retries',()=>{
  const reqs=[0,1,2].map(i=>({...req(4*H-i*H),id:100+i}));
  assert.equal(state(reqs),'needs-manual');
  assert.equal(decide([snap(pr,reqs),snap({...pr,number:2})],[],now).selected,2);
});
test('completed review settles an older in-progress marker',()=>{
  const comments=[bot('<!-- review in progress by coderabbit.ai -->',3*H)];
  const reviews=[{user:{login:'coderabbitai[bot]'},commit_id:pr.head.sha,submitted_at:stamp(2*H)}];
  assert.equal(state(comments,pr,reviews),'completed');
});
test('draft head is a lift candidate, foreign and closed still excluded',()=>{
  assert.equal(state([],{...pr,draft:true}),'draft-eligible');
  assert.equal(state([],{...pr,state:'closed'}),'excluded');
  assert.equal(state([],{...pr,user:{login:'other'}}),'excluded');
});
test('draft refusal cools down then permits another lift',()=>{
  const comments=[req(3*H),bot('Draft PR not reviewed. React with a ready state first.',2*H)];
  assert.equal(state(comments,{...pr,draft:true}),'draft-refused');
  const old=[req(9*H),bot('Draft PR not reviewed.',8*H)];
  assert.equal(state(old,{...pr,draft:true}),'draft-eligible');
});
test('trig markers count as admission like posted requests',()=>{
  const trig=(age,head=pr.head.sha)=>({body:`<!-- ocx-coderabbit-hourly trig head=${head} -->`,user:{login:'luvs01'},created_at:stamp(age),updated_at:stamp(age),issue_url:`https://api.github.com/repos/luvs01/opencodex/issues/${pr.number}`});
  assert.equal(isAdmission(trig(0)),true);
  assert.equal(markerInfo(trig(0))?.trig,true);
  assert.equal(isRequest(trig(0)),false);
  assert.equal(state([trig(5*60000)]),'awaiting-ack');
  assert.equal(state([trig(70*60000)]),'trigger-pending');
  assert.equal(state([trig(3*H)]),'trigger-pending');
  assert.equal(state([trig(3*H,'b'.repeat(40))]),'eligible');
  assert.equal(state([trig(9*H),trig(8*H),trig(7*H)]),'trigger-pending');
});
test('our own trig admission is not hidden by the updated_at bump',()=>{
  const trig={body:`<!-- ocx-coderabbit-hourly trig head=${pr.head.sha} -->`,user:{login:'luvs01'},created_at:stamp(1000),updated_at:stamp(1000)};
  assert.equal(state([trig],{...pr,updated_at:stamp(1000)}),'awaiting-ack');
});
test('active review holds whole queue',()=>assert.equal(decide([snap(pr,[bot('<!-- review in progress by coderabbit.ai -->')]),snap({...pr,number:2})],[],now).reason,'running'));
test('stale review is isolated not blindly repeated',()=>assert.equal(decide([snap(pr,[bot('<!-- review in progress by coderabbit.ai -->',3*H)]),snap({...pr,number:2})],[],now).selected,2));
function fixture(){
  let posts=0,t=now;const calls=[];const posted=new Map();
  const api=(name,fn)=>async p=>{calls.push(name);return {data:fn(p)}};
  const github={
    graphql:async q=>{calls.push('graphql');return q.includes('markPullRequestReadyForReview')?{markPullRequestReadyForReview:{pullRequest:{isDraft:false}}}:{convertPullRequestToDraft:{pullRequest:{isDraft:true}}}},
    rest:{issues:{
      listCommentsForRepo:api('recent',()=>[]),
      listComments:api('comments',()=>[]),
      createComment:api('post',p=>{posts++;const id=100+posts;posted.set(id,p.body);return {id,body:p.body,created_at:new Date(t).toISOString()}}),
      updateComment:api('edit',p=>{posted.set(p.comment_id,p.body);return {id:p.comment_id,body:p.body}}),
      getComment:api('getComment',p=>({id:p.comment_id,user:{login:p.comment_id===55?'coderabbitai[bot]':'luvs01'},body:posted.get(p.comment_id)??''}))
    },pulls:{list:api('pulls',()=>[pr]),listReviews:api('reviews',()=>[]),get:api('get',()=>pr)},reactions:{listForIssueComment:api('reactions',()=>[])}}
  };
  const summary={addHeading(){return this},addRaw(){return this},async write(){}};
  return {github,context:{repo:{owner:'luvs01',repo:'opencodex-automation'}},core:{info(){},summary,warning(){}},clock:()=>t,sleep:async ms=>{t+=ms},posts:()=>posts,calls,posted};
}
test('dry run never posts',async()=>{const f=fixture();const r=await run({...f,dryRun:true});assert.equal(r.selected,1);assert.equal(f.posts(),0)});
test('live request posted once and read back',async()=>{const f=fixture();const r=await run({...f,dryRun:false});assert.equal(r.reason,'posted-awaiting-ack');assert.equal(f.posts(),1)});
test('head race prevents write',async()=>{const f=fixture();f.github.rest.pulls.get=async()=>({data:{...pr,head:{sha:'c'.repeat(40)}}});await run({...f,dryRun:false});assert.equal(f.posts(),0)});
test('new cooldown at final read prevents write',async()=>{const f=fixture();let n=0;f.github.rest.issues.listCommentsForRepo=async()=>({data:++n===1?[]:[bot('More reviews will be available in 21 minutes.')]});await run({...f,dryRun:false});assert.equal(f.posts(),0)});
test('ambiguous POST is not retried',async()=>{const f=fixture();let n=0;f.github.rest.issues.createComment=async()=>{n++;throw Error('timeout')};await assert.rejects(run({...f,dryRun:false}));assert.equal(n,1)});
test('upstream guarded before any API call',async()=>{const f=fixture();await assert.rejects(run({...f,context:{repo:{owner:'lidge-jun',repo:'opencodex'}}}));assert.equal(f.calls.length,0)});

test('old fork controller is rejected before any API call',async()=>{const f=fixture();await assert.rejects(run({...f,context:{repo:{owner:'luvs01',repo:'opencodex'}}}));assert.equal(f.calls.length,0)});
test('every repository API call targets the fork, never the controller or upstream',async()=>{
  const f=fixture();let checked=0;
  for(const group of Object.values(f.github.rest))for(const [key,method] of Object.entries(group))group[key]=async p=>{assert.equal(p.owner,'luvs01');assert.equal(p.repo,'opencodex');checked++;return method(p)};
  await run({...f,dryRun:false});assert.equal(f.posts(),1);assert.ok(checked>0);
});

const draftPr={...pr,node_id:'PR_1',draft:true};
const skipBox=(age=H)=>({id:55,body:`<!-- skip review by coderabbit.ai -->\n> ## Draft PR not reviewed\n> - [ ] <!-- {"checkboxId":"e9bb8d72-00e8-4f67-9cb2-caf3b22574fe"} --> Trigger a manual review\n<!-- autopilot:start -->\n- [ ] <!-- {"checkboxId":"2708ad07-9f24-4260-9c11-7dc76a49f2e3"} --> <strong>Autofix</strong>`,user:{login:'coderabbitai[bot]'},created_at:stamp(age),updated_at:stamp(age)});
function trigged(f,{draft=true}={}){
  const target=draft?{...pr,node_id:'PR_1',draft:true}:pr;
  f.github.rest.pulls.list=async()=>({data:[target]});
  f.github.rest.pulls.get=async()=>({data:target});
  let reads=0;
  // Sweep and final recheck see the skip-review box; the ack poll additionally
  // sees CodeRabbit's progress comment.
  f.github.rest.issues.listComments=async()=>({data:++reads<3?[skipBox()]:[skipBox(),{...bot('<!-- review in progress by coderabbit.ai -->'),id:56}]});
  return f;
}
test('a draft with a trigger box is toggled and marker-posted without PR mutations',async()=>{
  const f=trigged(fixture());
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,1);assert.equal(r.trigger,'trigger-acknowledged');
  assert.equal(f.posts(),1);
  assert.ok([...f.posted.values()][0].includes('trig head='));
  assert.equal(f.calls.filter(c=>c==='graphql').length,0);
  assert.equal(f.calls.filter(c=>c==='edit').length,2); // checkbox plus durable positive receipt
});
test('a draft without a trigger box reports no surface instead of lifting',async()=>{
  const f=trigged(fixture());
  f.github.rest.issues.listComments=async()=>({data:[]});
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,0);assert.equal(r.reason,'no-eligible-head');
  assert.equal(r.states[0].state,'no-trigger-surface');
  assert.equal(f.posts(),0);assert.equal(f.calls.filter(c=>c==='edit').length,0);
});
test('a ready head prefers the checkbox over a comment request',async()=>{
  const f=trigged(fixture(),{draft:false});
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,1);
  assert.equal(f.posts(),1);assert.ok([...f.posted.values()][0].includes('trig head='));
});
test('a ready head without a box falls back to a comment request',async()=>{
  const f=trigged(fixture(),{draft:false});
  f.github.rest.issues.listComments=async()=>({data:[]});
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,1);assert.equal(f.posts(),1);
  assert.ok([...f.posted.values()][0].includes('@coderabbitai review'));
});
test('checkbox re-render alone stays pending without proof of review acceptance',async()=>{
  const f=trigged(fixture());
  f.github.rest.issues.listComments=async()=>({data:[skipBox()]});
  f.github.rest.issues.getComment=async()=>({data:{...skipBox(),body:skipBox().body.replace('Trigger a manual review','Check again to try again')}});
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,1);assert.equal(r.trigger,'trigger-ack-timeout');assert.equal(r.checkbox,'unchecked');
});
test('a refused trigger reports the refusal',async()=>{
  const f=trigged(fixture());
  let reads=0;
  f.github.rest.issues.listComments=async()=>({data:++reads<3?[skipBox()]:[skipBox(),{...bot('Draft PR not reviewed. Please mark ready for review.'),id:56}]});
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,1);assert.equal(r.trigger,'trigger-refused');
});
test('dry run inspects drafts without toggling',async()=>{
  const f=trigged(fixture());
  const r=await run({...f,dryRun:true});
  assert.equal(r.states[0].state,'draft-eligible');assert.equal(f.posts(),0);
  assert.equal(f.calls.filter(c=>c==='edit').length,0);
});
test('legacy lift markers are ignored by the trigger path',()=>{
  const lift={body:`<!-- ocx-coderabbit-hourly lift head=${pr.head.sha} -->`,user:{login:'luvs01'},created_at:stamp(50*60000),updated_at:stamp(50*60000)};
  assert.equal(state([lift]),'eligible');
});
test('three draft refusals on one head need manual review',()=>{
  const reqs=[req(9*H),req(8*H),req(7*H)].map((r,i)=>({...r,id:100+i}));
  assert.equal(state([...reqs,bot('Draft PR not reviewed.',30*60000)],{...pr,draft:true}),'needs-manual');
});
test('duplicate invocation recovers posted request and does not post twice',async()=>{
  const f=fixture();assert.equal((await run({...f,dryRun:false})).requested,1);
  f.github.rest.issues.listComments=async()=>({data:[req(0)]});
  assert.equal((await run({...f,dryRun:false})).reason,'hourly-cooldown');assert.equal(f.posts(),1);
});
test('permission error during listing fails without posting or retrying',async()=>{
  const f=fixture();let reads=0;f.github.rest.pulls.list=async()=>{reads++;throw Object.assign(Error('Forbidden'),{status:403})};
  await assert.rejects(run({...f,dryRun:false}),{status:403});assert.equal(reads,1);assert.equal(f.posts(),0);
});

test('real manual-review checkbox preserves ID and leaves Autofix untouched',async()=>{
  const f=trigged(fixture());
  const parsed=manualReviewCheckboxes(skipBox());
  assert.equal(parsed.length,1);assert.equal(parsed[0].id,'e9bb8d72-00e8-4f67-9cb2-caf3b22574fe');
  await run({...f,dryRun:false});
  assert.equal(f.posted.get(55),skipBox().body.replace('> - [ ]','> - [x]'));
  assert.ok(f.posted.get(55).includes('- [ ] <!-- {"checkboxId":"2708ad07'));
});
test('legacy label and retry label parse but foreign and Autofix controls do not',()=>{
  for(const label of ['🔍 Trigger review','Trigger a manual review','Check again to try again']) {
    const c={...skipBox(),body:`> - [ ] <!-- {"checkboxId":"cb-1"} --> ${label}`};
    assert.equal(manualReviewCheckboxes(c).length,1);
    assert.equal(manualReviewCheckboxes({...c,user:{login:'stranger'}}).length,0);
  }
  assert.equal(manualReviewCheckboxes({...skipBox(),body:'- [ ] Autofix'}).length,0);
});
test('draft with no actionable surface does not starve a later draft',async()=>{
  const f=fixture(), second={...draftPr,number:2};
  f.github.rest.pulls.list=async()=>({data:[draftPr,second]});
  f.github.rest.pulls.get=async p=>({data:p.pull_number===2?second:draftPr});
  let reads=0;
  f.github.rest.issues.listComments=async p=>({data:p.issue_number===1?[]:++reads<3?[skipBox()]:[skipBox(),{...bot('Review started.'),id:56}]});
  const r=await run({...f,dryRun:false});
  assert.equal(r.number,2);assert.equal(r.requested,1);assert.equal(f.posts(),1);
  assert.equal(r.states[0].state,'no-trigger-surface');
});
test('checked-only draft control is not toggled again and does not starve later ready PR',async()=>{
  const second={...pr,number:2};
  const checked={...skipBox(),body:skipBox().body.replace('> - [ ]','> - [x]')};
  const plan=decide([snap(draftPr,[checked]),snap(second)],[],now);
  assert.equal(plan.selected,2);assert.equal(plan.states[0].state,'trigger-control-checked');
});
test('fast consumption before first readback accepts independent fresh progress',async()=>{
  const f=trigged(fixture());
  const get=f.github.rest.issues.getComment;
  f.github.rest.issues.getComment=async p=>p.comment_id===55?{data:skipBox()}:get(p);
  const r=await run({...f,dryRun:false});
  assert.equal(r.trigger,'trigger-acknowledged');assert.equal(r.checkbox,'unchecked');
  assert.equal(r.reason,'posted-acknowledged');assert.equal(f.calls.filter(c=>c==='edit').length,2);
});
test('fast exact-head review completion is recognized with an unchecked box',async()=>{
  const f=trigged(fixture());let reads=0;
  const get=f.github.rest.issues.getComment;
  f.github.rest.issues.getComment=async p=>p.comment_id===55?{data:skipBox()}:get(p);
  f.github.rest.pulls.listReviews=async()=>({data:++reads<3?[]:[{id:100,user:{login:'coderabbitai[bot]'},commit_id:pr.head.sha,submitted_at:stamp(0)}]});
  const r=await run({...f,dryRun:false});
  assert.equal(r.trigger,'trigger-completed');assert.equal(r.reason,'posted-completed');
});
test('explicit refusal wins over simultaneous new progress or completion',()=>{
  const events=[{...bot('Review started. Review finished.'),id:56},{...bot('Review limit reached. Please wait 21 minutes.'),id:57}];
  assert.equal(triggerEvidence(pr,events,[],now,[]),'trigger-refused');
});
test('stale skip text is not a fresh refusal when provider adds progress',()=>{
  const updated={...skipBox(),updated_at:stamp(0),body:skipBox().body+'\n<!-- review in progress by coderabbit.ai -->'};
  assert.equal(triggerEvidence(pr,[updated],[],now,[skipBox()]),'trigger-acknowledged');
});
test('edited old progress without a new signal cannot acknowledge a request',()=>{
  const old={...bot('Review started.',H),id:56};
  const updated={...old,updated_at:stamp(0),body:old.body+'\nUnrelated footer edit.'};
  assert.equal(triggerEvidence(pr,[updated],[],now,[old]),null);
  assert.equal(triggerEvidence(pr,[updated],[],now),null);
});
test('other-head and pre-request signals do not acknowledge the current request',()=>{
  assert.equal(triggerEvidence(pr,[{...bot('Review started. head='+ 'b'.repeat(40)),id:56}],[],now,[]),null);
  assert.equal(triggerEvidence(pr,[{...bot('Review started.',1000),id:57}],[],now,[]),null);
  assert.equal(triggerEvidence(pr,[],[{user:{login:'coderabbitai[bot]'},commit_id:'b'.repeat(40),submitted_at:stamp(0)}],now,[]),null);
});
test('button disappearance alone remains pending and does not trigger a fallback',async()=>{
  const f=trigged(fixture());
  f.github.rest.issues.listComments=async()=>({data:[skipBox()]});
  f.github.rest.issues.getComment=async()=>{throw Object.assign(Error('Not Found'),{status:404})};
  const r=await run({...f,dryRun:false});
  assert.equal(r.trigger,'trigger-ack-timeout');assert.equal(r.checkbox,'missing');
  assert.equal(f.posts(),1);assert.equal(f.calls.filter(c=>c==='edit').length,1);
});
test('head change during acknowledgement prevents attribution to the admitted head',async()=>{
  const f=trigged(fixture());let reads=0;
  f.github.rest.pulls.get=async()=>({data:++reads===1?draftPr:{...draftPr,head:{sha:'b'.repeat(40)}}});
  const r=await run({...f,dryRun:false});
  assert.equal(r.trigger,'trigger-head-changed');assert.equal(r.reason,'posted-awaiting-ack');assert.equal(f.posts(),1);
});
test('ambiguous PATCH is inspected once and held across subsequent runs without duplicate',async()=>{
  const f=trigged(fixture());let edits=0;
  f.github.rest.issues.listComments=async()=>({data:[skipBox()]});
  f.github.rest.issues.updateComment=async p=>{edits++;f.posted.set(p.comment_id,p.body);throw Error('response lost')};
  const r=await run({...f,dryRun:false});
  assert.equal(r.trigger,'trigger-write-ambiguous');assert.equal(r.writeOutcome,'applied');
  const admitted={...req(3*H),body:`<!-- ocx-coderabbit-hourly trig head=${pr.head.sha} -->`};
  f.github.rest.issues.listComments=async()=>({data:[skipBox(4*H),admitted]});
  const next=await run({...f,dryRun:false});
  assert.equal(next.states[0].state,'trigger-pending');assert.equal(edits,1);assert.equal(f.posts(),1);
});
test('explicit rejected PATCH is not counted as review admission or retried',async()=>{
  const f=trigged(fixture());const edit=f.github.rest.issues.updateComment;let attempts=0;
  f.github.rest.issues.updateComment=async p=>{if(p.comment_id===55){attempts++;throw Object.assign(Error('Forbidden'),{status:403})}return edit(p)};
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,0);assert.equal(r.reason,'trigger-write-rejected');assert.equal(r.accounting,'recorded');assert.equal(attempts,1);
  const rejected={...req(3*H),body:f.posted.get(r.commentId)};
  assert.equal(isAdmission(rejected),false);assert.equal(state([rejected],draftPr),'trigger-write-rejected');
  assert.equal(decide([snap(draftPr,[skipBox(),rejected]),snap({...pr,number:2})],[],now).selected,2);
});
test('uncertain rejected-marker accounting remains conservative with no second toggle',async()=>{
  const f=trigged(fixture());let edits=0;
  f.github.rest.issues.updateComment=async()=>{edits++;throw Object.assign(Error('Forbidden'),{status:403})};
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,0);assert.equal(r.accounting,'uncertain');assert.equal(edits,2);
  assert.equal(isAdmission({...req(0),body:f.posted.get(r.commentId)}),true);
});
test('provider capacity refusal of checkbox admission retains timed bounded recovery',()=>{
  const admitted={...req(2*H),body:`<!-- ocx-coderabbit-hourly trig head=${pr.head.sha} -->`};
  const limited=bot('More reviews will be available in 21 minutes.');
  assert.equal(state([admitted,limited],draftPr),'rate-limited');
  assert.equal(state([admitted,{...limited,created_at:stamp(H),updated_at:stamp(H)}],draftPr),'draft-eligible');
});
test('latest checked control supersedes an older unchecked copy with the same ID',()=>{
  const old=skipBox(2*H), latest={...skipBox(H),id:56,body:skipBox(H).body.replace('> - [ ]','> - [x]')};
  assert.equal(decide([snap(draftPr,[old,latest])],[],now).states[0].state,'trigger-control-checked');
});
test('a fresh trig refusal overrides simultaneous progress in recovered state',()=>{
  const admitted={...req(2*H),body:`<!-- ocx-coderabbit-hourly trig head=${pr.head.sha} -->`};
  assert.equal(state([admitted,bot('Review started. <!-- review in progress by coderabbit.ai -->'),bot('Review limit reached. Please wait 21 minutes.')],draftPr),'rate-limited');
});
test('our checkbox PATCH timestamp cannot freshen old progress or exact-head completion',()=>{
  const old={...skipBox(),body:skipBox().body+`\n<!-- review in progress by coderabbit.ai -->\nFull review finished.\n<!-- recent_review_start --><!-- change_assessment_commit:"${pr.head.sha}" -->`};
  const patched={...old,updated_at:stamp(0),body:old.body.replace('> - [ ]','> - [x]')};
  assert.equal(triggerEvidence(pr,[patched],[],now,[old]),null);
  const refused={...bot('Review limit reached. Please wait 21 minutes.'),id:56};
  assert.equal(triggerEvidence(pr,[patched,refused],[],now,[old]),'trigger-refused');
});
test('only newly observed exact-head review IDs establish in-run completion',()=>{
  const previous={id:100,user:{login:'coderabbitai[bot]'},commit_id:pr.head.sha,submitted_at:stamp(0)};
  assert.equal(triggerEvidence(pr,[],[previous],now,[],[previous]),null);
  assert.equal(triggerEvidence(pr,[],[{...previous,id:101}],now,[],[previous]),'trigger-completed');
});
test('unconfirmed checkbox does not block another eligible PR after global cooldown',()=>{
  const admitted={...req(3*H),body:`<!-- ocx-coderabbit-hourly trig head=${pr.head.sha} -->`};
  const plan=decide([snap(draftPr,[skipBox(4*H),admitted]),snap({...pr,number:2})],[],now);
  assert.equal(plan.states[0].state,'trigger-pending');assert.equal(plan.selected,2);
});

test('newest checked surface supersedes older unchecked surface with a different checkbox ID',()=>{
  const old={...skipBox(2*H),body:skipBox(2*H).body.replace('e9bb8d72-00e8-4f67-9cb2-caf3b22574fe','old-control-B')};
  const latest={...skipBox(H),id:56,body:skipBox(H).body.replace('> - [ ]','> - [x]')};
  const plan=decide([snap(draftPr,[old,latest]),snap({...pr,number:2})],[],now);
  assert.equal(plan.states[0].state,'trigger-control-checked');assert.equal(plan.selected,2);
});
test('ready checked-only surface never falls back to a command POST',async()=>{
  const f=trigged(fixture(),{draft:false});
  f.github.rest.issues.listComments=async()=>({data:[{...skipBox(),body:skipBox().body.replace('> - [ ]','> - [x]')}]});
  const r=await run({...f,dryRun:false});
  assert.equal(r.requested,0);assert.equal(r.states[0].state,'trigger-control-checked');
  assert.equal(f.posts(),0);assert.equal(f.calls.filter(c=>c==='edit').length,0);
});
async function oldWalkthroughAdmission({receiptFailure=false,lostReceiptResponse=false,receiptReadFailure=false}={}) {
  const f=trigged(fixture());
  const old=skipBox(H), updated={...old,updated_at:stamp(0),body:old.body+'\nReview started.'};
  let reads=0;
  f.github.rest.issues.listComments=async()=>({data:[++reads<3?old:updated]});
  const edit=f.github.rest.issues.updateComment, get=f.github.rest.issues.getComment;
  let receiptWrites=0;
  f.github.rest.issues.updateComment=async p=>{
    if(p.comment_id!==55){
      receiptWrites++;
      if(receiptFailure)throw Object.assign(Error('Forbidden'),{status:403});
      const result=await edit(p);
      if(lostReceiptResponse)throw Error('response lost');
      return result;
    }
    return edit(p);
  };
  if(receiptReadFailure)f.github.rest.issues.getComment=async p=>{if(p.comment_id!==55)throw Error('read failed');return get(p)};
  const result=await run({...f,dryRun:false});
  const marker={...req(0),id:result.commentId,body:f.posted.get(result.commentId),updated_at:stamp(0)};
  return {f,result,marker,updated,receiptWrites};
}
test('persisted old-walkthrough acknowledgement blocks another PR at 61 minutes',async()=>{
  const {result,marker,updated}=await oldWalkthroughAdmission();
  assert.equal(result.confirmation,'recorded');assert.equal(result.trigger,'trigger-acknowledged');
  const receipt=markerInfo(marker);
  assert.equal(receipt.head,pr.head.sha);assert.equal(receipt.confirmation.sourceKind,'comment');
  assert.equal(receipt.confirmation.sourceId,'55');assert.equal(receipt.confirmation.observedAt,now);
  const later=now+61*60000;
  const plan=decide([snap(draftPr,[updated,marker]),snap({...pr,number:2})],[],later);
  assert.equal(plan.states[0].state,'acknowledged');assert.equal(plan.reason,'acknowledged');assert.equal(plan.selected,undefined);
  const expired=decide([snap(draftPr,[updated,marker]),snap({...pr,number:2})],[],now+121*60000);
  assert.equal(expired.states[0].state,'retry-eligible');
});
test('failed positive-receipt PATCH retains cross-run busy protection via initial signal baseline',async()=>{
  const {result,marker,updated,receiptWrites}=await oldWalkthroughAdmission({receiptFailure:true});
  assert.equal(result.trigger,'trigger-confirmation-uncertain');assert.equal(result.confirmation,'uncertain');
  assert.equal(receiptWrites,1);assert.equal(markerInfo(marker).confirmation,null);assert.ok(markerInfo(marker).baseline);
  const plan=decide([snap(draftPr,[updated,marker]),snap({...pr,number:2})],[],now+61*60000);
  assert.equal(plan.states[0].state,'acknowledged');assert.equal(plan.reason,'acknowledged');assert.equal(plan.selected,undefined);
});
test('ambiguous positive-receipt PATCH is read back without a duplicate write',async()=>{
  const {result,marker,updated,receiptWrites}=await oldWalkthroughAdmission({lostReceiptResponse:true});
  assert.equal(result.confirmation,'recorded');assert.equal(receiptWrites,1);
  assert.equal(decide([snap(draftPr,[updated,marker]),snap({...pr,number:2})],[],now+61*60000).reason,'acknowledged');
});
test('positive-receipt readback failure still preserves baseline recovery after one hour',async()=>{
  const {result,marker,updated,receiptWrites}=await oldWalkthroughAdmission({receiptReadFailure:true});
  assert.equal(result.confirmation,'uncertain');assert.equal(receiptWrites,1);
  assert.equal(decide([snap(draftPr,[updated,marker]),snap({...pr,number:2})],[],now+61*60000).reason,'acknowledged');
});
test('initial baseline does not promote our own checkbox edit into a global busy review',async()=>{
  const f=trigged(fixture());
  f.github.rest.issues.listComments=async()=>({data:[skipBox()]});
  const result=await run({...f,dryRun:false});
  const marker={...req(0),id:result.commentId,body:f.posted.get(result.commentId)};
  const patched={...skipBox(),updated_at:stamp(0),body:f.posted.get(55)};
  const plan=decide([snap(draftPr,[patched,marker]),snap({...pr,number:2})],[],now+61*60000);
  assert.equal(plan.states[0].state,'trigger-pending');assert.equal(plan.selected,2);
});
test('persisted acknowledgement never overrides a new explicit provider refusal',async()=>{
  const {marker,updated}=await oldWalkthroughAdmission();
  const refused={...bot('Review limit reached. Please wait 2 hours.'),id:57,created_at:new Date(now+60*60000).toISOString(),updated_at:new Date(now+60*60000).toISOString()};
  const plan=decide([snap(draftPr,[updated,marker,refused]),snap({...pr,number:2})],[],now+61*60000);
  assert.equal(plan.states[0].state,'rate-limited');assert.equal(plan.reason,'provider-cooldown');
});
test('verified positive receipt retains the busy window if provider later re-renders away progress',async()=>{
  const {marker}=await oldWalkthroughAdmission();
  const plan=decide([snap(draftPr,[skipBox(),marker]),snap({...pr,number:2})],[],now+61*60000);
  assert.equal(plan.reason,'acknowledged');assert.equal(plan.selected,undefined);
  const otherHead={...draftPr,head:{sha:'b'.repeat(40)}};
  assert.equal(analyze(otherHead,[skipBox(),marker],[],[],now+61*60000).state,'draft-eligible');
});
test('unsafe positive evidence ID cannot turn an unknown request into a timed retry',()=>{
  const marker={...req(3*H),body:`<!-- ocx-coderabbit-hourly trig head=${pr.head.sha} ack=progress evidence=comment:9007199254740993 observed_at=${stamp(3*H)} -->`};
  assert.equal(markerInfo(marker).confirmation,null);
  assert.equal(state([marker]),'trigger-pending');
  assert.equal(decide([snap(pr,[marker])],[],now).selected,null);
});
test('impossible progress-review evidence pair stays pending after the busy window',()=>{
  const marker={...req(3*H),body:`<!-- ocx-coderabbit-hourly trig head=${pr.head.sha} ack=progress evidence=review:123 observed_at=${stamp(3*H)} -->`};
  assert.equal(markerInfo(marker).confirmation,null);
  assert.equal(state([marker]),'trigger-pending');
  assert.equal(decide([snap(pr,[marker])],[],now).selected,null);
});
