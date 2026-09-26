import { Worker } from 'node:worker_threads';
export class Engine {
  constructor() { this.sequence = 0; this.pending = null; this.ready = false; this.start(); }
  start() {
    this.worker = new Worker(new URL('./ai-worker.mjs', import.meta.url));
    this.worker.on('message', result => {
      if (result.type === 'ready') { this.ready = true; return; }
      if (this.pending?.id === result.id) {
        const p = this.pending; this.pending = null; clearTimeout(p.timeout);
        result.error ? p.reject(Error(result.error)) : p.resolve(result);
      }
    });
    this.worker.on('error', e => this.fail(e));
    this.worker.on('exit', code => { this.ready = false; if (code) this.fail(Error(`AI worker exited: ${code}`)); });
  }
  fail(error) { this.ready = false; if (this.pending) { clearTimeout(this.pending.timeout); this.pending.reject(error); this.pending = null; } }
  calculate(game) {
    if (!this.ready) return Promise.reject(Error('AI 引擎尚未就绪，请稍候或重启服务。'));
    if (this.pending) return Promise.reject(Error('AI 正在思考，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => { this.fail(Error('AI 思考超过 60 秒，已暂停本局。')); this.worker.terminate(); }, 60000);
      this.pending = { id, resolve, reject, timeout };
      this.worker.postMessage({ id, board: game.board, ratio: game.strength, gameId: game.id });
    });
  }
  close() { return this.worker.terminate(); }
}
