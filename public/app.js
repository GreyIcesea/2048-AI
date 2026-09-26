'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const fmt = value => Number(value || 0).toLocaleString('zh-CN');
const modes = {manual:'手动',ai:'纯 AI',assisted:'AI 辅助'};
const statuses = {active:'进行中',finished:'已结束',abandoned:'已中止',running:'运行中',paused:'已暂停',cancelled:'已终止'};
let game=null,platform=null,currentUser=null,page='play',rankMode='manual',selectedRunId=null,lastDetailRefresh=0,busy=false,moving=false,polling=false,register=false,toastTimer,moveTimer;
const boardCells = Array.from({length:16},()=>{const cell=document.createElement('div');cell.className='cell';$('#board').append(cell);return cell;});
const liveCells = Array.from({length:16},()=>{const cell=document.createElement('div');cell.className='cell';$('#live-board').append(cell);return cell;});
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,3500);}
async function api(path,data){
  const response=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
}
async function action(fn){try{await fn();}catch(error){toast(error.message);}}
function tileClass(value){return value?' tile-'+(value>4096?'large':value):'';}
function drawBoard(cells,values,spawnIndex=-1){
  cells.forEach((cell,index)=>{const value=values?.[index]||0;cell.className='cell'+tileClass(value)+(index===spawnIndex?' fresh':'');cell.textContent=value||'';cell.dataset.value=String(value);cell.setAttribute('aria-label',`第 ${Math.floor(index/4)+1} 行第 ${index%4+1} 列：${value||'空'}`);});
}
function movementPlan(board,direction){
  const result=[];
  for(let line=0;line<4;line++){
    const ids=Array.from({length:4},(_,k)=>direction===1?line*4+k:direction===2?line*4+3-k:direction===3?k*4+line:(3-k)*4+line);
    let destination=0,lastValue=0,merged=false;
    for(const from of ids){
      const value=board[from];if(!value)continue;
      let to;if(value===lastValue&&!merged){to=ids[destination-1];merged=true;}
      else{to=ids[destination++];lastValue=value;merged=false;}
      result.push({from,to,value});
    }
  }
  return result;
}
function stopMotion(){clearTimeout(moveTimer);$('#board .moving-layer')?.remove();moving=false;}
function animateMove(previous,next){
  const plan=movementPlan(previous.board,next.lastDirection),board=$('#board'),bounds=board.getBoundingClientRect();
  const arrivals=new Map();for(const item of plan)arrivals.set(item.to,(arrivals.get(item.to)||0)+1);
  const layer=document.createElement('div');layer.className='moving-layer';
  for(const item of plan){
    const start=boardCells[item.from].getBoundingClientRect(),end=boardCells[item.to].getBoundingClientRect();
    const tile=document.createElement('div');tile.className='moving-tile'+tileClass(item.value);tile.textContent=item.value;
    tile.style.left=`${start.left-bounds.left}px`;tile.style.top=`${start.top-bounds.top}px`;
    tile.style.width=`${start.width}px`;tile.style.height=`${start.height}px`;
    tile.dataset.dx=String(end.left-start.left);tile.dataset.dy=String(end.top-start.top);layer.append(tile);
  }
  drawBoard(boardCells,Array(16).fill(0));board.append(layer);moving=true;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{for(const tile of layer.children)tile.style.transform=`translate(${tile.dataset.dx}px,${tile.dataset.dy}px)`;}));
  moveTimer=setTimeout(()=>{stopMotion();drawBoard(boardCells,game.board,game.spawn?.index);for(const [index,count] of arrivals)if(count===2)boardCells[index].classList.add('merged');renderGame();},190);
}
function acceptGame(next){
  if(game&&next.id===game.id&&next.version<game.version)return;
  const previous=game;game=next;
  if(moving)stopMotion();
  if(previous&&previous.id===next.id&&next.version===previous.version+1&&next.lastDirection&&previous.board.some((value,index)=>value!==next.board[index])&&page==='play'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)animateMove(previous,next);
  else drawBoard(boardCells,next.board,next.spawn?.index);
  renderGame();
}
function renderGame(){
  if(!game)return;
  $('#score').textContent=fmt(game.score);$('#max-tile').textContent=fmt(game.maxTile);$('#steps').textContent=fmt(game.steps);
  $('#new-game').disabled=busy;
  $$('.mobile-controls button').forEach(button=>button.disabled=busy||moving||game.running||game.status!=='active');
  $('#game-over').hidden=game.status!=='finished';$('#final-score').textContent=fmt(game.score);
}
async function newGame(){
  if(busy)return;busy=true;stopMotion();renderGame();
  try{acceptGame(await api('/api/games',{strength:1}));$('#board').focus({preventScroll:true});await ranking();}
  finally{busy=false;renderGame();}
}
async function humanMove(direction){
  if(busy||moving||!game||game.running||game.status!=='active'||page!=='play')return;
  busy=true;renderGame();
  try{acceptGame(await api(`/api/games/${game.id}/move`,{direction,version:game.version}));}
  finally{busy=false;renderGame();}
}
$('#new-game').onclick=()=>action(newGame);$('#play-again').onclick=()=>action(newGame);
$$('[data-direction]').forEach(button=>button.onclick=()=>action(()=>humanMove(Number(button.dataset.direction))));
document.addEventListener('keydown',event=>{
  if(page!=='play'||$('#auth-dialog').open||/INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)||event.altKey||event.ctrlKey||event.metaKey)return;
  const direction={ArrowLeft:1,a:1,A:1,ArrowRight:2,d:2,D:2,ArrowUp:3,w:3,W:3,ArrowDown:4,s:4,S:4}[event.key];
  if(direction){event.preventDefault();action(()=>humanMove(direction));}
});
let touchStart=null;
$('#board').addEventListener('pointerdown',event=>{touchStart={x:event.clientX,y:event.clientY,id:event.pointerId};$('#board').setPointerCapture(event.pointerId);});
$('#board').addEventListener('pointerup',event=>{if(!touchStart||touchStart.id!==event.pointerId)return;const dx=event.clientX-touchStart.x,dy=event.clientY-touchStart.y;touchStart=null;if(Math.max(Math.abs(dx),Math.abs(dy))>=24)action(()=>humanMove(Math.abs(dx)>Math.abs(dy)?dx>0?2:1:dy>0?4:3));});
$('#board').addEventListener('pointercancel',()=>touchStart=null);
async function changePage(next){
  if(!['play','lab','history','admin'].includes(next)||next==='admin'&&currentUser?.role!=='superadmin')next='play';
  page=next;$$('.page').forEach(section=>section.hidden=section.id!==`page-${page}`);
  $$('.nav').forEach(button=>{button.classList.toggle('active',button.dataset.page===page);button.setAttribute('aria-current',button.dataset.page===page?'page':'false');});
  history.replaceState(null,'',`#${page}`);
  if(page==='play')await ranking();if(page==='history')await historyPage();if(page==='lab')await refreshPlatform();if(page==='admin')await refreshAdmin();
}
$$('[data-page]').forEach(button=>button.onclick=()=>action(()=>changePage(button.dataset.page)));
$('.brand').onclick=event=>{event.preventDefault();action(()=>changePage('play'));};
window.addEventListener('hashchange',()=>action(()=>changePage(location.hash.slice(1))));
function empty(container,title){const el=document.createElement('div');el.className='empty-state';el.textContent=title;container.replaceChildren(el);}
function table(container,headers,rows){
  const el=document.createElement('table'),head=el.createTHead().insertRow();
  headers.forEach(label=>{const th=document.createElement('th');th.scope='col';th.textContent=label;head.append(th);});
  const body=el.createTBody();rows.forEach(row=>{const tr=body.insertRow();row.forEach(value=>{tr.insertCell().textContent=value;});});container.replaceChildren(el);
}
async function ranking(){
  const mode=rankMode,{rows}=await api(`/api/ranking?mode=${mode}`);if(mode!==rankMode)return;
  if(!rows.length)return empty($('#ranking-content'),'暂无成绩');
  table($('#ranking-content'),['#','玩家','分数','方块'],rows.slice(0,10).map((row,index)=>[index+1,row.name,fmt(row.score),fmt(row.maxTile)]));
}
$$('#rank-tabs button').forEach(button=>button.onclick=()=>action(async()=>{rankMode=button.dataset.mode;$$('#rank-tabs button').forEach(item=>item.classList.toggle('selected',item===button));await ranking();}));
async function historyPage(){
  const {rows,stats}=await api('/api/history'),container=$('#history-summary');container.replaceChildren();
  for(const [label,value] of [['完赛局数',stats.total],['平均分数',stats.averageScore],['最佳成绩',stats.bestScore]]){
    const item=document.createElement('div'),title=document.createElement('label'),number=document.createElement('strong');title.textContent=label;number.textContent=fmt(value);item.append(title,number);container.append(item);
  }
  if(!rows.length)return empty($('#history-content'),'还没有记录');
  table($('#history-content'),['日期','模式','状态','分数','最大方块','步数'],rows.map(row=>[new Date(row.endedAt||row.startedAt).toLocaleDateString('zh-CN'),modes[row.mode],statuses[row.status],fmt(row.score),fmt(row.maxTile),fmt(row.steps)]));
}
function canManageAI(){return currentUser?.role==='superadmin'||!!currentUser?.manageAI;}
function renderPlatform(){
  const b=platform?.batch,stats=b?.stats;
  $('#ai-controls').hidden=!canManageAI();
  $('#batch-status').textContent=b?statuses[b.status]:'尚未开始';
  $('#live-heading').textContent=b?.game?'正在运行第 '+(b.completed+1)+' 局':b?'当前批次':'等待运行';
  drawBoard(liveCells,b?.game?.board||Array(16).fill(0));
  $('#batch-current').textContent=b?.game?`第 ${fmt(b.game.steps)} 步 · 最大方块 ${fmt(b.game.maxTile)}`:b?.status==='finished'?'批次已完成':'尚无正在运行的对局';
  $('#batch-current-score').textContent=b?.game?fmt(b.game.score)+' 分':'—';
  const direction={1:'← 左',2:'→ 右',3:'↑ 上',4:'↓ 下'}[b?.game?.lastDirection];
  $('#live-action').textContent=direction?`最近操作 ${direction} · 思考 ${fmt(b.game.lastAI?.ms)} ms · 深度 ${b.game.lastAI?.depth??'—'}`:'等待下一步';
  $('#batch-progress').textContent=b?`${b.completed} / ${b.target}`:'—';
  $('#total-runs').textContent=platform?fmt(platform.totals.total):'—';
  $('#batch-average').textContent=stats?.total?fmt(stats.averageScore):'—';
  $('#batch-best').textContent=stats?.total?fmt(stats.bestScore):'—';
  $('#batch-bar').max=b?.target||1;$('#batch-bar').value=b?.completed||0;
  $('#run-meta').textContent=b?`第 ${fmt(platform.runs)} 次测试 · 强度 ${b.strength}× · ${stats.total} 局已完成`:'等待管理员启动测试';
  $('#batch-error').hidden=!b?.error;$('#batch-error').textContent=b?.error||'';
  const active=b&&['running','paused'].includes(b.status);
  $('#batch-start').disabled=!!active||!platform?.engineReady;
  $('#batch-count').disabled=!!active;$('#batch-strength').disabled=!!active;
  $('#batch-pause').disabled=!active;$('#batch-cancel').disabled=!active;
  $('#batch-pause').textContent=b?.status==='paused'?'继续':'暂停';
}
function renderRates(stats){
  const rates=$('#batch-rates');rates.replaceChildren();
  for(const value of [8192,16384,32768,65536]){
    const count=stats?.[`reached${value}`]||0,total=stats?.total||0,row=document.createElement('div');
    row.className='rate';row.innerHTML='<span></span><div class="rate-bar"><i></i></div><strong></strong>';
    row.querySelector('span').textContent=fmt(value);row.querySelector('i').style.width=total?`${count/total*100}%`:'0%';
    row.querySelector('strong').textContent=total?`${(count/total*100).toFixed(1)}%`:'—';rates.append(row);
  }
}
async function refreshPlatform(forceDetails=false){
  platform=await api('/api/platform');renderPlatform();
  if($('.detail-card').open&&(forceDetails||Date.now()-lastDetailRefresh>3000)){
    lastDetailRefresh=Date.now();
    const runs=(await api('/api/platform/runs')).rows;
    if(!selectedRunId||!runs.some(run=>run.id===selectedRunId))selectedRunId=runs[0]?.id||null;
    const list=$('#platform-runs');list.replaceChildren();
    if(!runs.length)empty(list,'暂无测试');
    else{
      const tableEl=document.createElement('table'),head=tableEl.createTHead().insertRow();
      for(const label of ['开始时间','状态','完成','平均分','最佳分','']){const th=document.createElement('th');th.textContent=label;head.append(th);}
      const body=tableEl.createTBody();
      runs.forEach(run=>{const row=body.insertRow();for(const value of [new Date(run.startedAt).toLocaleDateString('zh-CN'),statuses[run.status],`${run.completed}/${run.target}`,fmt(run.stats.averageScore),fmt(run.stats.bestScore)])row.insertCell().textContent=value;
        const button=document.createElement('button');button.className='run-button'+(run.id===selectedRunId?' selected':'');button.textContent='查看';button.onclick=()=>{selectedRunId=run.id;action(()=>refreshPlatform(true));};row.insertCell().append(button);
      });list.append(tableEl);
    }
    const selected=runs.find(run=>run.id===selectedRunId);
    $('#selected-run-title').textContent=selected?`方块达成率 · ${new Date(selected.startedAt).toLocaleDateString('zh-CN')}`:'方块达成率';
    renderRates(selected?.stats);
    const {rows}=await api('/api/platform/games'+(selectedRunId?`?batch=${encodeURIComponent(selectedRunId)}`:''));
    if(!rows.length)empty($('#platform-games'),'暂无对局');
    else table($('#platform-games'),['状态','分数','方块','步数'],rows.map(row=>[statuses[row.status],fmt(row.score),fmt(row.maxTile),fmt(row.steps)]));
  }
}
$('.detail-card').ontoggle=()=>{if($('.detail-card').open)action(()=>refreshPlatform(true));};
$('#batch-start').onclick=()=>action(async()=>{
  const count=$('#batch-count'),strength=$('#batch-strength');
  if(!count.reportValidity()||!strength.reportValidity())return;
  await api('/api/platform/start',{count:Number(count.value),strength:Number(strength.value)});
  await refreshPlatform();
});
$('#batch-pause').onclick=()=>action(async()=>{await api('/api/platform/control',{status:platform.batch.status==='paused'?'running':'paused'});await refreshPlatform();});
$('#batch-cancel').onclick=()=>action(async()=>{if(!confirm('终止当前测试？'))return;await api('/api/platform/control',{status:'cancelled'});await refreshPlatform();});
function renderAccount(){
  $('#account').textContent=currentUser?.name||'登录 / 注册';
  $('#admin-nav').hidden=currentUser?.role!=='superadmin';
  $('#ai-controls').hidden=!canManageAI();
}
function openAuth(){
  $('#auth-form').hidden=!!currentUser;$('#profile').hidden=!currentUser;
  $('#profile-name').textContent=currentUser?.name||'';
  $('#profile-role').textContent=currentUser?.role==='superadmin'?'超级管理员':currentUser?.role==='admin'?'管理员':'普通用户';
  $('#auth-error').hidden=true;$('#auth-dialog').showModal();
}
$('#account').onclick=openAuth;$('#auth-close').onclick=()=>$('#auth-dialog').close();$('#profile-close').onclick=()=>$('#auth-dialog').close();
$('#auth-toggle').onclick=()=>{register=!register;$('#auth-title').textContent=register?'创建账号':'登录';$('#auth-submit').textContent=register?'创建账号':'登录';$('#auth-toggle').textContent=register?'返回登录':'创建账号';$('#password').autocomplete=register?'new-password':'current-password';$('#auth-error').hidden=true;};
$('#auth-form').onsubmit=async event=>{
  event.preventDefault();$('#auth-submit').disabled=true;$('#auth-error').hidden=true;
  try{const result=await api(register?'/api/register':'/api/login',{name:$('#username').value,password:$('#password').value});currentUser=result.user;renderAccount();$('#auth-dialog').close();$('#password').value='';toast('已登录');if(page==='history')await historyPage();if(page==='lab')renderPlatform();}
  catch(error){$('#auth-error').hidden=false;$('#auth-error').textContent=error.message;}
  finally{$('#auth-submit').disabled=false;}
};
$('#logout').onclick=()=>action(async()=>{await api('/api/logout',{});currentUser=null;renderAccount();$('#auth-dialog').close();if(page==='admin')await changePage('play');else if(page==='history')await historyPage();toast('已退出登录');});
function metric(container,label,value){
  const item=document.createElement('div'),name=document.createElement('label'),number=document.createElement('strong');name.textContent=label;number.textContent=value;item.append(name,number);container.append(item);
}
async function refreshMachine(){
  if(currentUser?.role!=='superadmin')return;
  const machine=await api('/api/admin/machine');
  const stats=$('#machine-stats');stats.replaceChildren();
  metric(stats,'系统 CPU',machine.system.cpuPercent==null?'采样中':machine.system.cpuPercent.toFixed(1)+'%');
  metric(stats,'服务 CPU',machine.process.cpuPercent==null?'采样中':machine.process.cpuPercent.toFixed(1)+'%');
  metric(stats,'进程内存',`${(machine.process.rss/1048576).toFixed(0)} MB`);
  metric(stats,'JS 堆内存',`${(machine.process.heapUsed/1048576).toFixed(0)} MB`);
  metric(stats,'系统内存',`${((machine.system.totalMemory-machine.system.freeMemory)/1073741824).toFixed(1)} / ${(machine.system.totalMemory/1073741824).toFixed(1)} GB`);
  metric(stats,'CPU 核心',String(machine.system.cpuCount));
  metric(stats,'引擎',machine.engine.busy?'计算中':machine.engine.ready?'就绪':'加载中');
  metric(stats,'活动对局',String(machine.activeGames));
  metric(stats,'待处理请求',String(machine.queuedJobs));
  metric(stats,'服务运行',`${Math.floor(machine.process.uptime/60)} 分钟`);
}
async function refreshAdmin(){
  if(currentUser?.role!=='superadmin')return;
  const [,users]=await Promise.all([refreshMachine(),api('/api/admin/users')]);
  const list=$('#admin-users');list.replaceChildren();
  for(const user of users.rows){
    const row=document.createElement('div');row.className='user-row';
    const name=document.createElement('strong');name.textContent=user.name;row.append(name);
    if(user.role==='superadmin'){const label=document.createElement('span');label.textContent='超级管理员';row.append(label);}
    else{
      const role=document.createElement('select');role.setAttribute('aria-label',`${user.name} 的角色`);
      for(const [value,label] of [['user','普通用户'],['admin','管理员']]){const option=document.createElement('option');option.value=value;option.textContent=label;role.append(option);}
      role.value=user.role;
      const permission=document.createElement('label');permission.className='check-label';const check=document.createElement('input');check.type='checkbox';check.checked=!!user.manageAI;check.disabled=role.value!=='admin';permission.append(check,'管理 AI');
      role.onchange=()=>{check.disabled=role.value!=='admin';if(check.disabled)check.checked=false;};
      const save=document.createElement('button');save.className='subtle';save.textContent='保存';
      save.onclick=()=>action(async()=>{save.disabled=true;try{await api('/api/admin/users/role',{id:user.id,role:role.value,manageAI:check.checked});toast('权限已保存');await refreshAdmin();}finally{save.disabled=false;}});
      row.append(role,permission,save);
    }
    list.append(row);
  }
}
$('#create-admin').onsubmit=event=>action(async()=>{
  event.preventDefault();const form=event.currentTarget,submit=form.querySelector('button[type=submit]');submit.disabled=true;
  try{await api('/api/admin/users',{name:form.elements.name.value,password:form.elements.password.value,manageAI:form.elements.manageAI.checked});form.reset();toast('管理员已创建');await refreshAdmin();}
  finally{submit.disabled=false;}
});
async function poll(){
  if(polling)return;polling=true;
  try{
    if(game?.status==='active'&&!busy){const id=game.id,result=await api(`/api/games/${id}`);if(game?.id===id&&result.version!==game.version)acceptGame(result);}
    if(page==='lab')await refreshPlatform();if(page==='admin')await refreshMachine();
  }catch(error){toast('连接中断，正在重试');}
  finally{polling=false;}
}
async function boot(){
  try{
    const state=await api('/api/state');currentUser=state.user;renderAccount();
    if(state.game)acceptGame(state.game);else await newGame();
    await changePage(location.hash.slice(1)||'play');setInterval(poll,500);
  }catch(error){toast('服务暂不可用：'+error.message);}
}
boot();
