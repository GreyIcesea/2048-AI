import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { legalMoves } from '../lib/game.mjs';
const port=21480;
function client(){
  return {cookie:'',async call(path,data){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{headers:{Cookie:this.cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})});
    if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
    const body=await response.text();
    return {status:response.status,data:response.headers.get('content-type')?.includes('json')?JSON.parse(body):body};
  }};
}
test('public game, platform display and role boundaries', {timeout:45000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'2048-platform-test-'));
  const adminPassword=randomBytes(20).toString('hex');
  const playerPassword=randomBytes(20).toString('hex');
  let server;
  function start(){server=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),DB_PATH:join(dir,'test.sqlite'),ADMIN_PASSWORD:adminPassword},stdio:'pipe'});server.stderr.on('data',data=>process.stderr.write(data));}
  async function stop(){if(server.exitCode!==null)return;const done=new Promise(resolve=>server.once('exit',resolve));server.kill();await done;}
  start();
  const guest=client(),admin=client(),viewer=client();
  try{
    for(let i=0;i<100;i++){try{if((await guest.call('/api/state')).data.engine.ready)break;}catch{}await wait(100);}
    assert.equal((await guest.call('/api/platform')).status,200);
    assert.equal((await guest.call('/api/platform/start',{count:1,strength:.25})).status,403);
    assert.equal((await guest.call('/api/admin/machine')).status,403);
    assert.equal((await guest.call('/api/batches',{count:1,strength:.25})).status,403);
    assert.equal((await viewer.call('/api/register',{name:'普通玩家',password:playerPassword})).status,200);
    assert.equal((await admin.call('/api/login',{name:'admin',password:adminPassword})).data.user.role,'superadmin');
    assert.equal((await admin.call('/api/admin/machine')).status,200);
    assert.equal((await viewer.call('/api/admin/users',{name:'受限管理员',password:playerPassword,manageAI:true})).status,403);
    assert.equal((await admin.call('/api/admin/users',{name:'受限管理员',password:playerPassword,manageAI:false})).status,200);
    let game=(await viewer.call('/api/games',{strength:1})).data;
    assert.equal((await viewer.call(`/api/games/${game.id}/control`,{running:true})).status,403);
    assert.equal((await viewer.call(`/api/games/${game.id}/step`,{version:game.version})).status,403);
    assert.equal((await guest.call(`/api/games/${game.id}`)).status,404);
    const direction=legalMoves(game.board)[0];
    game=(await viewer.call(`/api/games/${game.id}/move`,{direction,version:game.version})).data;
    assert.equal(game.steps,1);
    assert.equal((await viewer.call(`/api/games/${game.id}/move`,{direction,version:0})).status,409);
    assert.equal((await admin.call('/api/platform/start',{count:1.5,strength:1})).status,400);
    assert.equal((await admin.call('/api/platform/start',{count:1,strength:0.2})).status,400);
    assert.equal((await admin.call('/api/platform/start',{count:1,strength:4.1})).status,400);
    let batch=(await admin.call('/api/platform/start',{count:37,strength:1.35})).data;
    assert.equal(batch.platform,true);
    assert.equal(batch.target,37);
    assert.equal(batch.strength,1.35);
    await wait(150);
    assert.equal((await guest.call('/api/platform')).data.batch.id,batch.id);
    assert.equal((await guest.call('/api/platform/games')).status,200);
    assert.equal((await guest.call('/api/platform/runs')).data.rows[0].id,batch.id);
    assert.equal((await viewer.call('/api/platform/control',{status:'paused'})).status,403);
    batch=(await admin.call('/api/platform/control',{status:'paused'})).data;
    assert.equal(batch.status,'paused');
    const pausedSteps=batch.game?.steps||0,pausedCompleted=batch.completed;
    await stop();start();
    for(let i=0;i<100;i++){try{if((await guest.call('/api/state')).data.engine.ready)break;}catch{}await wait(100);}
    assert.equal((await guest.call('/api/platform')).data.batch.status,'paused');
    assert.equal((await admin.call('/api/platform/control',{status:'running'})).data.status,'running');
    let advanced=false;
    for(let i=0;i<30;i++){await wait(100);const current=(await guest.call('/api/platform')).data.batch;if(current.completed>pausedCompleted||current.game?.steps>pausedSteps){advanced=true;break;}}
    assert.equal(advanced,true);
    const user=(await admin.call('/api/admin/users')).data.rows.find(row=>row.name==='普通玩家');
    assert.ok(user);
    assert.equal((await viewer.call('/api/admin/users/role',{id:user.id,role:'admin',manageAI:true})).status,403);
    assert.equal((await admin.call('/api/admin/users/role',{id:user.id,role:'admin',manageAI:true})).status,200);
    assert.equal((await viewer.call('/api/platform/control',{status:'cancelled'})).status,200);
    assert.equal((await viewer.call('/api/admin/machine')).status,403);
    assert.equal((await admin.call('/api/admin/users/role',{id:user.id,role:'user',manageAI:false})).status,200);
    assert.equal((await viewer.call('/api/platform/start',{count:1,strength:.25})).status,403);
    assert.equal((await viewer.call('/api/history')).data.rows.length,1);
    assert.equal((await viewer.call('/api/ranking?mode=manual')).status,200);
  }finally{
    await stop();
  }
});
