import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT, expires INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, owner TEXT NOT NULL, user_id TEXT, batch_id TEXT, status TEXT NOT NULL,
        mode TEXT NOT NULL, score INTEGER NOT NULL, max_tile INTEGER NOT NULL, steps INTEGER NOT NULL, ended_at TEXT, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS games_rank ON games(status,mode,score DESC);
      CREATE INDEX IF NOT EXISTS games_owner ON games(owner);
      CREATE INDEX IF NOT EXISTS games_batch ON games(batch_id);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, owner TEXT NOT NULL, user_id TEXT, state TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(users)').all().map(row => row.name);
    if (!columns.includes('role')) this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    if (!columns.includes('manage_ai')) this.db.exec('ALTER TABLE users ADD COLUMN manage_ai INTEGER NOT NULL DEFAULT 0');
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
  saveGame(g) {
    this.db.prepare(`INSERT INTO games VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, mode=excluded.mode, score=excluded.score, max_tile=excluded.max_tile,
      steps=excluded.steps, ended_at=excluded.ended_at, state=excluded.state`).run(g.id,g.owner,g.userId,g.batchId,g.status,g.mode,g.score,g.maxTile,g.steps,g.endedAt || null,JSON.stringify(g));
  }
  saveBatch(b) { this.db.prepare('INSERT INTO batches VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,state=excluded.state').run(b.id,b.owner,b.userId,JSON.stringify(b)); }
  game(id) { const r = this.db.prepare('SELECT state FROM games WHERE id=?').get(id); return r && JSON.parse(r.state); }
  batch(id) { const r = this.db.prepare('SELECT state FROM batches WHERE id=?').get(id); return r && JSON.parse(r.state); }
  stats(where = '1=1', args = []) {
    return this.db.prepare(`SELECT COUNT(*) total, COALESCE(ROUND(AVG(score)),0) averageScore, COALESCE(MAX(score),0) bestScore,
      COALESCE(ROUND(AVG(steps)),0) averageSteps, COALESCE(MAX(max_tile),0) maxTile,
      COALESCE(SUM(max_tile>=8192),0) reached8192, COALESCE(SUM(max_tile>=16384),0) reached16384,
      COALESCE(SUM(max_tile>=32768),0) reached32768, COALESCE(SUM(max_tile>=65536),0) reached65536
      FROM games WHERE status='finished' AND ${where}`).get(...args);
  }
}
