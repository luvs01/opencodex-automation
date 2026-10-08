import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isRequest,parseLimit,latestLimit,analyze,decide,run} from '../scripts/coderabbit-queue.mjs';
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
test('draft closed foreign author excluded',()=>{for(const p of [{...pr,draft:true},{...pr,state:'closed'},{...pr,user:{login:'other'}}])assert.equal(state([],p),'excluded')});
test('pause preserved despite fresh refusal',()=>assert.equal(state([bot('Review limit reached.')],{...pr,body:'@coderabbitai ignore'}),'paused'));
test('paused owner command preserved and resume restores',()=>{const pause={...req(),body:'@coderabbitai pause'};assert.equal(state([pause]),'paused');assert.equal(state([pause,{...req(1000),body:'@coderabbitai resume'}]),'eligible')});
test('fresh PR defers selection',()=>assert.equal(state([],{...pr,updated_at:stamp(60000)}),'recent-activity'));
test('exact head review completes',()=>assert.equal(state([],pr,[{user:{login:'coderabbitai[bot]'},commit_id:pr.head.sha,submitted_at:stamp(1000)}]),'completed'));
test('explicit current processing takes precedence over earlier completed review',()=>assert.equal(state([bot('<!-- review in progress by coderabbit.ai -->')],pr,[{user:{login:'coderabbitai[bot]'},commit_id:pr.head.sha,submitted_at:stamp(H)}]),'running'));
test('walkthrough head marker completes',()=>assert.equal(state([bot(`<!-- recent_review_start --><!-- change_assessment_commit:"${pr.head.sha}" -->`)]),'completed'));
test('first ten minutes await acknowledgement',()=>assert.equal(state([req(5*60000)]),'awaiting-ack'));
test('unacknowledged request quarantined, not repeated',()=>assert.equal(state([req(70*60000)]),'quarantined-unacknowledged'));
test('eyes reaction acknowledges',()=>assert.equal(state([req(15*60000)],pr,[],[{user:{login:'coderabbitai[bot]'},content:'eyes'}]),'acknowledged'));
test('foreign reaction not acknowledged',()=>assert.equal(state([req(15*60000)],pr,[],[{user:{login:'stranger'},content:'eyes'}]),'quarantined-unacknowledged'));
test('new head recovers tagged quarantine',()=>assert.equal(state([req(2*H,'b'.repeat(40))]),'eligible'));
test('explicit refusal retries after stated time',()=>assert.equal(state([req(2*H),bot('Review limit reached. Please wait 10 minutes.',30*60000)]),'eligible'));
test('quota-query answer is not review acknowledgement',()=>assert.equal(state([req(2*H),{...req(1000),id:124,body:'@coderabbitai rate limit'},bot('More reviews will be available in 21 minutes.')]),'quarantined-unacknowledged'));
test('capacity reply to review is explicit refusal',()=>assert.equal(state([req(20*60000),bot('More reviews will be available in 21 minutes.')]),'rate-limited'));
test('expired direct capacity refusal permits recovery',()=>assert.equal(state([req(2*H),bot('More reviews will be available in 21 minutes.',H)]),'eligible'));
test('manual unknown outcome is not hidden by PR updatedAt',()=>assert.equal(state([{...req(20*60000),body:'@coderabbitai review'}],{...pr,updated_at:stamp(1000)}),'quarantined-unacknowledged'));
test('fresh and stale processing distinguished',()=>{assert.equal(state([bot('<!-- review in progress by coderabbit.ai -->',1000)]),'running');assert.equal(state([bot('<!-- review in progress by coderabbit.ai -->',3*H)]),'stale-running')});
test('owner one-hour budget and provider delay both honored',()=>{const p=decide([snap()],[req(20*60000),bot('More reviews will be available in 21 minutes.')],now);assert.equal(p.reason,'hourly-cooldown');assert.equal(p.nextEligibleAt,new Date(now+40*60000).toISOString())});
test('old bot probe ignored while real quota still gates',()=>{const p=decide([snap()],[{...req(1000),user:{login:'github-actions[bot]'}},bot('More reviews will be available in 21 minutes.')],now);assert.equal(p.reason,'provider-cooldown');assert.equal(p.nextEligibleAt,new Date(now+21*60000).toISOString())});
test('one quarantined head does not freeze other PRs',()=>{const p=decide([snap(pr,[req(2*H)]),snap({...pr,number:2})],[],now);assert.equal(p.selected,2)});
test('active review holds whole queue',()=>assert.equal(decide([snap(pr,[bot('<!-- review in progress by coderabbit.ai -->')]),snap({...pr,number:2})],[],now).reason,'running'));
test('stale review is isolated not blindly repeated',()=>assert.equal(decide([snap(pr,[bot('<!-- review in progress by coderabbit.ai -->',3*H)]),snap({...pr,number:2})],[],now).selected,2));
function fixture(){let posts=0;const calls=[];const api=(name,fn)=>async p=>{calls.push(name);return {data:fn(p)}};const github={rest:{issues:{listCommentsForRepo:api('recent',()=>[]),listComments:api('comments',()=>[]),createComment:api('post',p=>{posts++;return {id:12,body:p.body}}),getComment:api('getComment',()=>({user:{login:'luvs01'},body:`@coderabbitai review\n\n<!-- ocx-coderabbit-hourly head=${pr.head.sha} -->`}))},pulls:{list:api('pulls',()=>[pr]),listReviews:api('reviews',()=>[]),get:api('get',()=>pr)},reactions:{listForIssueComment:api('reactions',()=>[])}}};const summary={addHeading(){return this},addRaw(){return this},async write(){}};return {github,context:{repo:{owner:'luvs01',repo:'opencodex-automation'}},core:{info(){},summary},clock:()=>now,posts:()=>posts,calls}}
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

test('two draft heads are visible with explicit reasons and never posted',async()=>{
  const f=fixture();let summary='';
  f.core.summary.addRaw=function(text){summary+=text;return this};
  f.github.rest.pulls.list=async()=>({data:[{...pr,number:700,draft:true},{...pr,number:701,draft:true}]});
  const r=await run({...f,dryRun:false});
  assert.equal(r.reason,'no-eligible-head');
  assert.deepEqual(r.states.map(s=>[s.number,s.state,s.exclusionReason]),[[700,'excluded','draft'],[701,'excluded','draft']]);
  assert.match(summary,/#700: excluded \(draft\)/);assert.match(summary,/#701: excluded \(draft\)/);
  assert.equal(f.posts(),0);assert.ok(!f.calls.includes('comments'));assert.ok(!f.calls.includes('reviews'));
});
test('draft skip-review comment cannot masquerade as a running or completed review',()=>{
  const p={...pr,draft:true};
  assert.deepEqual(analyze(p,[bot('Draft PR not reviewed')],[],[],now),{state:'excluded',exclusionReason:'draft'});
  assert.equal(state([bot('Draft PR not reviewed')],pr),'eligible');
});
test('draft becoming ready between invocations enters normal eligibility checks',async()=>{
  const f=fixture();let draft=true;
  f.github.rest.pulls.list=async()=>({data:[{...pr,draft}]});
  assert.equal((await run({...f,dryRun:false})).states[0].exclusionReason,'draft');assert.equal(f.posts(),0);
  draft=false;assert.equal((await run({...f,dryRun:false})).requested,1);assert.equal(f.posts(),1);
});
test('ready to draft race prevents external write and reports draft exclusion',async()=>{
  const f=fixture();f.github.rest.pulls.get=async()=>({data:{...pr,draft:true}});
  const r=await run({...f,dryRun:false});assert.equal(f.posts(),0);
  assert.equal(r.reason,'state-changed-before-post');assert.equal(r.states[0].exclusionReason,'draft');
});
test('drafts do not block an eligible ready head or bypass global quota',async()=>{
  const f=fixture();f.github.rest.pulls.list=async()=>({data:[{...pr,number:700,draft:true},pr]});
  assert.equal((await run({...f,dryRun:false})).requested,1);assert.equal(f.posts(),1);
  const g=fixture();g.github.rest.pulls.list=f.github.rest.pulls.list;
  g.github.rest.issues.listCommentsForRepo=async()=>({data:[bot('More reviews will be available in 21 minutes.')]});
  assert.equal((await run({...g,dryRun:false})).reason,'provider-cooldown');assert.equal(g.posts(),0);
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
