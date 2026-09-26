import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cpus, freemem, totalmem, uptime as systemUptime } from 'node:os';
import { Engine } from './lib/ai.mjs';
import { Store } from './lib/store.mjs';
import { newBoard, applyMove } from './lib/game.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const store = new Store(process.env.DB_PATH || join(root, 'data/2048.sqlite'));
const engine = new Engine();
const scrypt = promisify(scryptCb);
const port = Number(process.env.PORT || 2048);
const host = '127.0.0.1';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN) : null;
if (publicOrigin && (!['http:','https:'].includes(publicOrigin.protocol) || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash)) throw Error('PUBLIC_ORIGIN 必须是站点根地址，例如 https://2048.example.com');
const manifest = JSON.parse(readFileSync(join(root, 'engine/manifest.json')));
const games = new Map();
const batches = new Map();
const jobs = [];
const pendingSteps = new Set();
const loginAttempts = new Map();
let lastMachineSample = null;
const adminName = 'admin';
const existingAdmin = store.db.prepare('SELECT id FROM users WHERE name_key=?').get(adminName);
if (process.env.ADMIN_PASSWORD) {
  const adminPassword=process.env.ADMIN_PASSWORD;
  if (adminPassword.length<8||adminPassword.length>128) throw Error('ADMIN_PASSWORD 长度须为 8–128 个字符');
  const salt=randomBytes(16).toString('hex'),hash=(await scrypt(adminPassword,salt,64)).toString('hex');
  if (existingAdmin) store.db.prepare("UPDATE users SET salt=?,hash=?,role='superadmin',manage_ai=1 WHERE id=?").run(salt,hash,existingAdmin.id);
  else store.db.prepare("INSERT INTO users(id,name,name_key,salt,hash,role,manage_ai) VALUES(?,?,?,?,?,'superadmin',1)")
    .run(randomUUID(),adminName,adminName,salt,hash);
} else if (!existingAdmin) throw Error('首次启动须设置 ADMIN_PASSWORD 环境变量以创建管理员账号');
let schedulerBusy = false;
let lastScheduled = '';
let closing = false;
for (const row of store.db.prepare("SELECT state FROM games WHERE status='active'").all()) {
  const g = JSON.parse(row.state); g.running = false; g.version++; store.saveGame(g);
}
for (const row of store.db.prepare('SELECT state FROM batches').all()) {
  const b = JSON.parse(row.state); if (b.status === 'running') { b.status = 'paused'; store.saveBatch(b); }
}
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
function strength(value) { const n = Number(value); if (!Number.isFinite(n)||n<0.25||n>4) fail('思考预算应在 0.25–4 之间'); return n; }
function publicGame(g) { const { owner, userId, ...result } = g; return result; }
function publicBatch(b) { const { owner, userId, ...result } = b; return { ...result, stats: store.stats('batch_id=?', [b.id]), game: b.currentGame ? publicGame(getGame(b.currentGame)) : null }; }
function platformBatch() {
  const row=store.db.prepare("SELECT state FROM batches WHERE json_extract(state,'$.platform')=1 ORDER BY rowid DESC LIMIT 1").get();
  if (!row) return null;
  const batch=JSON.parse(row.state);
  return publicBatch(batches.get(batch.id) || batch);
}
function getGame(id) { let g = games.get(id); if (!g) { g = store.game(id); if (g?.status === 'active') games.set(id, g); } return g; }
function ownedGame(id, s) { const g = getGame(id); if (!g || g.owner !== s.token) fail('找不到这局游戏', 404); return g; }
function ownedBatch(id, s) { let b = batches.get(id) || store.batch(id); if (!b || b.owner !== s.token) fail('找不到这组测试',404); if (b.status !== 'finished' && b.status !== 'cancelled') batches.set(id,b); return b; }
function active(g) { if (g.status !== 'active') fail('这局已结束，请开始新游戏'); }
function save(g) { store.saveGame(g); if (g.status !== 'active') games.delete(g.id); }
function createGame(session, ratio = 1, batchId = null) {
  const board = newBoard();
  const g = { id: randomUUID(), owner: session.token, userId: session.user_id || null, batchId, board,
    score: 0, maxTile: Math.max(...board), steps: 0, version: 0, status: 'active', running: false,
    mode: batchId ? 'ai' : 'manual', humanMoves: 0, aiMoves: 0, strength: ratio, startedAt: new Date().toISOString(),
    endedAt: null, lastAI: null, error: null, delay: 120, spawn: null, lastDirection: null, engineCommit: manifest.commit };
  games.set(g.id, g); save(g); return g;
}
function endGame(g, status = 'abandoned') { g.status = status; g.running = false; g.version++; g.endedAt = new Date().toISOString(); save(g); }
function move(g, direction, ai = false) {
  if (applyMove(g,direction)) {
    if (ai) g.aiMoves++; else g.humanMoves++;
    g.mode = g.aiMoves ? (g.humanMoves ? 'assisted' : 'ai') : 'manual';
    g.error = null; save(g); return true;
  }
  return false;
}
async function think(g, job = null) {
  const version = g.version;
  const result = await engine.calculate(g);
  const b = g.batchId && batches.get(g.batchId);
  if (g.status !== 'active' || version !== g.version || (!job && !g.running && !b) || (b && b.status !== 'running')) return false;
  g.lastAI = result;
  move(g,result.direction,true);
  return true;
}
async function tick() {
  if (closing || schedulerBusy || !engine.ready) return;
  schedulerBusy = true;
  let g, b, job;
  try {
    while (jobs.length && !g) {
      job = jobs.shift(); g = getGame(job.id);
      if (!g || g.status !== 'active' || g.version !== job.version) {
        pendingSteps.delete(job.id); job.reject(Error('棋盘或控制状态已更新，请重试。')); g = null; job = null;
      }
    }
    if (!g) {
      const candidates = [...games.values()].filter(x => !x.batchId && x.running && Date.now() >= (x.nextAt || 0)).map(x => ({g:x}));
      for (const batch of batches.values()) {
        if (batch.status !== 'running') continue;
        if (!batch.currentGame) {
          const created = createGame({ token: batch.owner, user_id: batch.userId }, batch.strength, batch.id);
          batch.currentGame = created.id; store.saveBatch(batch);
        }
        candidates.push({g:getGame(batch.currentGame),b:batch});
      }
      if (!candidates.length) return;
      const index = candidates.findIndex(x => x.g.id === lastScheduled);
      ({g,b} = candidates[(index+1) % candidates.length]); lastScheduled = g.id;
    }
    if (g.status === 'active') await think(g,job);
    g.nextAt = Date.now() + g.delay;
    if (b && g.status === 'finished') {
      b.completed++; b.currentGame = null;
      if (b.completed >= b.target) { b.status = 'finished'; b.endedAt = new Date().toISOString(); }
      store.saveBatch(b);
    }
    job?.resolve(publicGame(g));
  } catch (e) {
    if (g) { g.running = false; g.error = e.message; save(g); }
    if (b) { b.status = 'paused'; b.error = e.message; store.saveBatch(b); }
    job?.reject(e);
    console.error(new Date().toISOString(), 'AI paused:', e.message);
  } finally { if(job) pendingSteps.delete(job.id); schedulerBusy = false; }
}
const timer = setInterval(tick, 15);

function session(req,res) {
  const raw = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  let s = raw && store.db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(raw, Date.now());
  if (!s) {
    s = { token: randomBytes(32).toString('hex'), user_id: null, expires: Date.now()+365*86400000 };
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(s.token,null,s.expires);
    res.setHeader('Set-Cookie', `sid=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${publicOrigin?.protocol==='https:'?'; Secure':''}`);
  }
  return s;
}
function user(s) { return s.user_id ? store.db.prepare('SELECT id,name,role,manage_ai manageAI FROM users WHERE id=?').get(s.user_id) : null; }
function requireAI(s) { const u=user(s); if (!u || !(u.role==='superadmin' || (u.role==='admin'&&u.manageAI))) fail('需要 AI 管理权限',403); return u; }
function requireSuper(s) { const u=user(s); if (u?.role!=='superadmin') fail('需要超级管理员权限',403); return u; }
function rotateSession(s,res,userId) {
  const token = randomBytes(32).toString('hex');
  const expires = Date.now()+365*86400000;
  // Preserve resumable games and batch ownership without retroactively claiming guest ranks.
  for (const row of store.db.prepare("SELECT state FROM games WHERE owner=? AND status='active'").all(s.token)) {
    const g = getGame(JSON.parse(row.state).id); g.owner = token; save(g);
  }
  for (const row of store.db.prepare('SELECT state FROM batches WHERE owner=?').all(s.token)) {
    const b = batches.get(JSON.parse(row.state).id) || JSON.parse(row.state); b.owner=token; store.saveBatch(b);
  }
  store.db.prepare('UPDATE games SET owner=? WHERE owner=?').run(token,s.token);
  store.db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,userId,expires);
  s.token=token; s.user_id=userId;
  res.setHeader('Set-Cookie',`sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${publicOrigin?.protocol==='https:'?'; Secure':''}`);
}
async function body(req) {
  let text = ''; for await (const part of req) { text += part; if (text.length > 8192) fail('请求过大',413); }
  try { return JSON.parse(text || '{}'); } catch { fail('无效 JSON'); }
}
function json(res,data,status=200) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
async function api(req,res,url) {
  const s = session(req,res);
  const path = url.pathname;
  const data = req.method === 'POST' ? await body(req) : {};
  if (path === '/api/state' && req.method === 'GET') {
    const row = store.db.prepare("SELECT id FROM games WHERE owner=? AND batch_id IS NULL AND status='active' ORDER BY rowid DESC LIMIT 1").get(s.token);
    const batch = store.db.prepare('SELECT state FROM batches WHERE owner=? ORDER BY rowid DESC LIMIT 1').get(s.token);
    return json(res,{ user:user(s), game:row ? publicGame(getGame(row.id)) : null,
      batch:batch ? publicBatch(ownedBatch(JSON.parse(batch.state).id,s)) : null,
      engine:{ ready:engine.ready, busy:!!engine.pending, ...manifest }, memoryMB:Math.round(process.memoryUsage().rss/1048576) });
  }
  if (path === '/api/platform' && req.method === 'GET') {
    const batch=platformBatch();
    const totals=store.stats('batch_id IN (SELECT id FROM batches WHERE json_extract(state,\'$.platform\')=1)');
    const runs=store.db.prepare("SELECT COUNT(*) total FROM batches WHERE json_extract(state,'$.platform')=1").get().total;
    return json(res,{batch,totals,runs,engineReady:engine.ready});
  }
  if (path === '/api/platform/games' && req.method === 'GET') {
    const latest=platformBatch(),id=url.searchParams.get('batch')||latest?.id;
    if (id&&!store.db.prepare("SELECT id FROM batches WHERE id=? AND json_extract(state,'$.platform')=1").get(id)) fail('测试不存在',404);
    const rows=id ? store.db.prepare('SELECT score,max_tile maxTile,steps,status,ended_at endedAt FROM games WHERE batch_id=? ORDER BY rowid DESC LIMIT 100').all(id) : [];
    return json(res,{rows});
  }
  if (path === '/api/platform/runs' && req.method === 'GET') {
    const rows=store.db.prepare("SELECT state FROM batches WHERE json_extract(state,'$.platform')=1 ORDER BY rowid DESC LIMIT 20").all()
      .map(row=>{const batch=JSON.parse(row.state);return {id:batch.id,status:batch.status,target:batch.target,completed:batch.completed,strength:batch.strength,startedAt:batch.startedAt,stats:store.stats('batch_id=?',[batch.id])};});
    return json(res,{rows});
  }
  if (path === '/api/platform/start' && req.method === 'POST') {
    requireAI(s);
    const latest=platformBatch();
    if (latest && ['running','paused'].includes(latest.status)) fail('当前测试尚未结束');
    if ([...batches.values()].some(b=>['running','paused'].includes(b.status))) fail('已有测试正在运行');
    const target=Number(data.count); if (!Number.isInteger(target)||target<1||target>1000) fail('测试局数应在 1–1000 之间');
    const b={id:randomUUID(),owner:s.token,userId:s.user_id,platform:true,target,completed:0,status:'running',strength:strength(data.strength ?? 1),currentGame:null,startedAt:new Date().toISOString(),error:null};
    batches.set(b.id,b);store.saveBatch(b);return json(res,publicBatch(b));
  }
  if (path === '/api/platform/control' && req.method === 'POST') {
    requireAI(s);const latest=platformBatch();if (!latest) fail('暂无测试',404);
    const b=batches.get(latest.id)||store.batch(latest.id);
    if (!['running','paused'].includes(b.status)) fail('测试已结束');
    if (!['running','paused','cancelled'].includes(data.status)) fail('控制参数无效');
    if (data.status==='running'&&!engine.ready) fail('AI 引擎未就绪',503);
    b.status=data.status;b.error=null;
    if (b.currentGame) { const g=getGame(b.currentGame);g.version++;if (b.status==='cancelled') {endGame(g);b.currentGame=null;} else save(g); }
    if (b.status!=='cancelled') batches.set(b.id,b);else batches.delete(b.id);
    store.saveBatch(b);return json(res,publicBatch(b));
  }
  if (path === '/api/admin/machine' && req.method === 'GET') {
    requireSuper(s);
    const mem=process.memoryUsage();
    const now=Date.now(),cpuTimes=cpus().map(cpu=>cpu.times);
    const total=cpuTimes.reduce((sum,times)=>sum+Object.values(times).reduce((a,b)=>a+b,0),0);
    const idle=cpuTimes.reduce((sum,times)=>sum+times.idle,0);
    const usage=process.cpuUsage();
    const systemCpuPercent=lastMachineSample&&total>lastMachineSample.total
      ?Math.max(0,Math.min(100,100*(1-(idle-lastMachineSample.idle)/(total-lastMachineSample.total)))):null;
    const processCpuPercent=lastMachineSample&&now>lastMachineSample.now
      ?Math.max(0,100*((usage.user+usage.system)-(lastMachineSample.usage.user+lastMachineSample.usage.system))/((now-lastMachineSample.now)*1000*cpuTimes.length)):null;
    lastMachineSample={now,total,idle,usage};
    return json(res,{process:{rss:mem.rss,heapUsed:mem.heapUsed,uptime:process.uptime(),cpuPercent:processCpuPercent},system:{totalMemory:totalmem(),freeMemory:freemem(),uptime:systemUptime(),cpuCount:cpuTimes.length,cpuPercent:systemCpuPercent},engine:{ready:engine.ready,busy:!!engine.pending},activeGames:games.size,activeBatches:batches.size,queuedJobs:jobs.length});
  }
  if (path === '/api/admin/users' && req.method === 'GET') {
    requireSuper(s);return json(res,{rows:store.db.prepare('SELECT id,name,role,manage_ai manageAI FROM users ORDER BY CASE role WHEN \'superadmin\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END,name').all()});
  }
  if (path === '/api/admin/users' && req.method === 'POST') {
    requireSuper(s);
    const name=String(data.name||'').normalize('NFKC').trim(),password=String(data.password||'');
    if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(name)) fail('用户名为 2–24 个汉字、字母、数字、_ 或 -');
    if (password.length<8||password.length>128) fail('密码长度为 8–128 个字符');
    const salt=randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');
    try {store.db.prepare("INSERT INTO users(id,name,name_key,salt,hash,role,manage_ai) VALUES(?,?,?,?,?,'admin',?)")
      .run(randomUUID(),name,name.toLowerCase(),salt,hash,data.manageAI===true?1:0);}
    catch {fail('这个用户名已被使用');}
    return json(res,{ok:true});
  }
  if (path === '/api/admin/users/role' && req.method === 'POST') {
    requireSuper(s);const target=store.db.prepare('SELECT id,role FROM users WHERE id=?').get(String(data.id||''));
    if (!target) fail('用户不存在',404);if (target.role==='superadmin') fail('不能修改超级管理员');
    if (!['user','admin'].includes(data.role)) fail('权限无效');
    const canManageAI=data.role==='admin' && data.manageAI===true ? 1:0;
    store.db.prepare('UPDATE users SET role=?,manage_ai=? WHERE id=?').run(data.role,canManageAI,target.id);
    return json(res,{ok:true});
  }
  if (['/api/register','/api/login'].includes(path) && req.method === 'POST') {
    const key = req.socket.remoteAddress;
    const attempt = loginAttempts.get(key) || {count:0,at:Date.now()};
    if (Date.now()-attempt.at>60000) { attempt.count=0; attempt.at=Date.now(); }
    attempt.count++; loginAttempts.set(key,attempt); if (attempt.count>20) fail('操作过于频繁，请一分钟后重试。',429);
    const name = String(data.name || '').normalize('NFKC').trim();
    const password = String(data.password || '');
    if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(name)) fail('用户名为 2–24 个汉字、字母、数字、_ 或 -');
    if (password.length<8 || password.length>128) fail('密码长度为 8–128 个字符');
    let account = store.db.prepare('SELECT * FROM users WHERE name_key=?').get(name.toLowerCase());
    if (path === '/api/register') {
      if (account) fail('这个用户名已被使用');
      const salt = randomBytes(16).toString('hex');
      account = {id:randomUUID(), name, salt, hash:(await scrypt(password,salt,64)).toString('hex')};
      try { store.db.prepare('INSERT INTO users(id,name,name_key,salt,hash) VALUES(?,?,?,?,?)').run(account.id,name,name.toLowerCase(),salt,account.hash); }
      catch { fail('这个用户名已被使用'); }
    } else {
      const actual = await scrypt(password,account?.salt || 'missing-account',64);
      if (!account || !timingSafeEqual(actual,Buffer.from(account.hash,'hex'))) fail('用户名或密码错误',401);
    }
    rotateSession(s,res,account.id); return json(res,{user:user(s)});
  }
  if (path === '/api/logout' && req.method === 'POST') { rotateSession(s,res,null); return json(res,{ok:true}); }
  if (path === '/api/games' && req.method === 'POST') {
    const ratio = strength(data.strength ?? 1);
    const current = store.db.prepare("SELECT id FROM games WHERE owner=? AND batch_id IS NULL AND status='active'").all(s.token);
    current.forEach(row => endGame(getGame(row.id)));
    return json(res,publicGame(createGame(s,ratio)));
  }
  const gm = /^\/api\/games\/([\w-]+)(?:\/(move|control|step))?$/.exec(path);
  if (gm) {
    const g = ownedGame(gm[1],s);
    if (req.method === 'GET' && !gm[2]) return json(res,publicGame(g));
    if (req.method !== 'POST') fail('方法不支持',405);
    if (g.batchId) fail('请通过批量测试控制这局');
    active(g);
    if (gm[2] === 'control') {
      if (data.strength !== undefined) g.strength = strength(data.strength);
      if (data.delay !== undefined) { const n = Number(data.delay); if (!Number.isInteger(n)||n<0||n>2000) fail('速度无效'); g.delay=n; }
      if (data.running !== undefined) {
        if (typeof data.running !== 'boolean') fail('控制参数无效');
        if (data.running) fail('个人游戏 AI 接管尚未开放',403);
        g.running=data.running;
      }
      g.version++; g.error=null; save(g); return json(res,publicGame(g));
    }
    if (gm[2] === 'move') {
      if (g.running) fail('请先暂停 AI');
      if (data.version !== g.version) fail('棋盘已更新，请重试',409);
      if (![1,2,3,4].includes(data.direction)) fail('无效方向');
      move(g,data.direction); return json(res,publicGame(g));
    }
    if (gm[2] === 'step') {
      fail('个人游戏 AI 接管尚未开放',403);
      if (!engine.ready) fail('AI 引擎未就绪',503);
      if (g.running) fail('请先暂停 AI');
      if (pendingSteps.has(g.id)||jobs.length>=8) fail('已有单步请求，请稍候',429);
      if (data.version !== g.version) fail('棋盘已更新，请重试',409);
      pendingSteps.add(g.id);
      return json(res,await new Promise((resolve,reject)=>jobs.push({id:g.id,version:g.version,resolve,reject})));
    }
  }
  if (path === '/api/batches' && req.method === 'POST') {
    requireAI(s);
    if ([...batches.values()].some(b=>['running','paused'].includes(b.status))) fail('已有批量测试，请先完成或终止它');
    // Also account for a paused job restored from disk.
    for (const row of store.db.prepare('SELECT state FROM batches').all()) if (['running','paused'].includes(JSON.parse(row.state).status)) fail('已有未完成的批量测试，请恢复或终止它');
    const target=Number(data.count); if (!Number.isInteger(target)||target<1||target>1000) fail('测试局数应在 1–1000 之间');
    const b={id:randomUUID(),owner:s.token,userId:s.user_id,target,completed:0,status:'running',strength:strength(data.strength ?? 1),currentGame:null,startedAt:new Date().toISOString(),error:null};
    batches.set(b.id,b); store.saveBatch(b); return json(res,publicBatch(b));
  }
  const bm = /^\/api\/batches\/([\w-]+)(?:\/(control|export))?$/.exec(path);
  if (bm) {
    requireAI(s);
    const b=ownedBatch(bm[1],s);
    if (req.method === 'GET' && !bm[2]) return json(res,publicBatch(b));
    if (req.method === 'GET' && bm[2] === 'export') return csv(res,store.db.prepare('SELECT state FROM games WHERE batch_id=? ORDER BY rowid').all(b.id));
    if (req.method === 'POST' && bm[2] === 'control') {
      if (!['running','paused'].includes(b.status)) fail('该测试已结束');
      if (!['running','paused','cancelled'].includes(data.status)) fail('控制参数无效');
      if (data.status === 'running' && !engine.ready) fail('AI 引擎未就绪',503);
      b.status=data.status; b.error=null;
      if (b.currentGame) { const g=getGame(b.currentGame); g.version++; if (b.status==='cancelled') { endGame(g); b.currentGame=null; } else save(g); }
      store.saveBatch(b); return json(res,publicBatch(b));
    }
  }
  if (path === '/api/ranking' && req.method === 'GET') {
    const mode=url.searchParams.get('mode') || 'manual'; if (!['manual','ai','assisted'].includes(mode)) fail('榜单无效');
    const rows=store.db.prepare(`WITH ranked AS (SELECT g.*,u.name,ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY score DESC,steps ASC) n
      FROM games g JOIN users u ON u.id=g.user_id WHERE status='finished' AND mode=?)
      SELECT name,score,max_tile maxTile,steps,ended_at endedAt FROM ranked WHERE n=1 ORDER BY score DESC,steps ASC LIMIT 50`).all(mode);
    return json(res,{rows});
  }
  if (path === '/api/history' && req.method === 'GET') {
    const clause=s.user_id ? 'user_id=?' : 'owner=?'; const owner=s.user_id || s.token;
    const rows=store.db.prepare(`SELECT state FROM games WHERE ${clause} ORDER BY rowid DESC LIMIT 100`).all(owner).map(r=>publicGame(JSON.parse(r.state)));
    return json(res,{rows,stats:store.stats(clause,[owner])});
  }
  if (path === '/api/history/export' && req.method === 'GET') {
    return csv(res,store.db.prepare(`SELECT state FROM games WHERE ${s.user_id?'user_id':'owner'}=? ORDER BY rowid`).all(s.user_id || s.token));
  }
  fail('接口不存在',404);
}
function csv(res,rows) {
  const fields=['id','status','mode','score','maxTile','steps','reached8192','reached16384','reached32768','reached65536','strength','startedAt','endedAt','engineCommit'];
  const lines=[fields.join(',')];
  for (const row of rows) {
    const g=JSON.parse(row.state); for (const v of [8192,16384,32768,65536]) g[`reached${v}`]=g.maxTile>=v;
    lines.push(fields.map(f=>JSON.stringify(g[f] ?? '')).join(','));
  }
  res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="2048-results.csv"','Cache-Control':'no-store'});
  res.end('\uFEFF'+lines.join('\r\n'));
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const allowed=new Set([`127.0.0.1:${port}`,`localhost:${port}`,...(publicOrigin?[publicOrigin.host]:[])]);
    if (!allowed.has(req.headers.host)) fail('Host 不允许',403);
    const url=new URL(req.url,`http://${req.headers.host}`);
    if (req.method==='POST' && req.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`,...(publicOrigin?[publicOrigin.origin]:[])].includes(req.headers.origin)) fail('跨站请求不允许',403);
    if (req.method==='POST' && !req.headers['content-type']?.startsWith('application/json')) fail('需要 application/json',415);
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    if (req.method!=='GET') fail('方法不支持',405);
    const files={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg'};
    const file=files[url.pathname]; if (!file) fail('页面不存在',404);
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':mime[extname(file)],'Cache-Control':'no-cache'}); res.end(readFileSync(join(root,'public',file)));
  } catch(e) { if (!res.headersSent) json(res,{error:e.status ? e.message : '操作失败：'+e.message},e.status || 500); else res.end(); }
});
server.listen(port,host,()=>console.log(`2048 Lab running at http://${host}:${port} | upstream ${manifest.commit.slice(0,8)}`));
server.on('error',e=>{console.error(e.message);process.exit(1);});
async function shutdown() { closing=true; clearInterval(timer); server.close(); for(const g of games.values()){g.running=false;save(g);} for(const b of batches.values()){if(b.status==='running')b.status='paused';store.saveBatch(b);} await engine.close();store.db.close();process.exit(0); }
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
