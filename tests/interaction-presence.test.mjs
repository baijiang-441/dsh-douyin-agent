import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionPresence, interactionStatus } from '../interaction-status.mjs';

const now = Date.parse('2026-10-24T13:00:00Z');
function fixture() {
  return {now,modelReady:true,friend:{policy:{enabled:true},status:'running'},chat:{running:true,worker:{alive:true,status:'running',heartbeatAt:new Date(now-500).toISOString()},policy:{allowlist:[{id:'one'},{id:'group'}]},contacts:[{id:'one',status:'ready',lastCheckedAt:new Date(now-2000).toISOString()},{id:'group',status:'ready',lastCheckedAt:new Date(now-3000).toISOString()}]}};
}
test('在线必须有真实心跳、模型、总许可和全部所选会话的接收证据',()=>{
  const f=fixture();assert.equal(interactionPresence(f).status,'online');assert.equal(interactionPresence(f).online,true);
  for(const change of [x=>x.friend.policy.enabled=false,x=>x.modelReady=false,x=>x.chat.worker.alive=false,x=>x.chat.running=false,x=>x.chat.worker.heartbeatAt=new Date(now-6000).toISOString(),x=>x.chat.contacts[1].status='paused',x=>x.chat.contacts[1].lastCheckedAt=new Date(now-121000).toISOString(),x=>x.chat.contacts.pop()]){const next=fixture();change(next);assert.equal(interactionPresence(next).online,false);}
});
test('观看与回复状态按真实工作阶段显示，待回复优先于观看',()=>{
  const f=fixture();f.watch={running:true,worker:{alive:true,heartbeatAt:now-500},phase:'observing'};
  assert.equal(interactionPresence(f).status,'watching');
  f.chat.contacts[0].pending={phase:'model',at:new Date(now-1000).toISOString()};
  assert.equal(interactionPresence(f).status,'replying');assert.equal(interactionPresence(f).online,true);
  f.chat.contacts[0].status='inflight';f.chat.contacts[0].pending.phase='sending';assert.equal(interactionPresence(f).status,'replying');
  f.chat.contacts[0].status='delivery-uncertain';assert.equal(interactionPresence(f).status,'attention');assert.equal(interactionPresence(f).online,false);
});
test('保存、启动、人工未答和失效观看不冒充正常在线',()=>{
  const f=fixture();f.friend.status='waiting-settings';assert.equal(interactionPresence(f).status,'preparing');
  f.friend.status='starting';assert.equal(interactionPresence(f).online,false);
  f.friend.status='running';f.chat.recovery={pendingManualCount:1,recoverableCount:0};assert.equal(interactionPresence(f).label,'有未答消息');
  f.chat.recovery={pendingManualCount:0,recoverableCount:1};assert.equal(interactionPresence(f).status,'replying');
  f.chat.recovery.recoverableCount=0;f.watch={running:true,worker:{alive:true,heartbeatAt:now-6000}};assert.equal(interactionPresence(f).status,'online');
  f.share={paused:true};assert.equal(interactionPresence(f).online,false);
});
test('历史已核对待答不一直阻止在线，公开presence不带消息或联系人正文',()=>{
  const f=fixture();f.chat.contacts[0].unanswered=[{handledByUserAt:new Date(now).toISOString(),text:'私密原文不进入状态栏'}];
  const presence=interactionPresence(f);assert.equal(presence.online,true);assert.equal(JSON.stringify(presence).includes('私密原文'),false);
  const status=interactionStatus({...f,now:undefined});assert.ok(status.presence);assert.equal(status.rows.some(item=>item.id==='spark'),false);
});

test('有明确活动收据的分享显示进行中，好友待答仍优先展示',()=>{
  const f=fixture();
  f.share={enabled:true,paused:false,busy:true,inProgress:true,recoveryRequired:false,needsReview:[],activity:{status:'sending',phase:'reserved',operationId:'synthetic-active-share'}};
  assert.equal(interactionPresence(f).status,'sharing');assert.equal(interactionPresence(f).online,true);
  f.share.activity.phase='clicking';assert.equal(interactionPresence(f).label,'在线 · 分享中');
  const row=interactionStatus(f).rows.find(item=>item.id==='share');assert.equal(row.running,true);assert.match(row.message,/正在分享/);
  f.chat.contacts[0].pending={phase:'model',at:new Date(now-500).toISOString()};assert.equal(interactionPresence(f).status,'replying');
  f.chat.worker.alive=false;assert.equal(interactionPresence(f).online,false);
});

test('不确定、残留与旧格式记录不会被分享进行中状态掩盖',()=>{
  for(const change of [s=>s.paused=true,s=>s.recoveryRequired=true,s=>s.needsReview=[{status:'uncertain',operationId:'synthetic-old-share'}]]){
    const f=fixture();f.share={enabled:true,paused:false,busy:true,inProgress:true,recoveryRequired:false,needsReview:[],activity:{status:'sending',phase:'clicking',operationId:'synthetic-active-share'}};change(f.share);
    assert.equal(interactionPresence(f).status,'attention');assert.equal(interactionPresence(f).online,false);
  }
  const legacy=fixture();legacy.share={paused:true,busy:true};assert.equal(interactionPresence(legacy).status,'attention');
  const stale=fixture();stale.share={enabled:true,paused:false,busy:false,inProgress:true,needsReview:[],activity:{status:'sending',phase:'reserved',operationId:'synthetic-stale-share'}};assert.notEqual(interactionPresence(stale).status,'sharing');
});
