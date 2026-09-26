import { parentPort } from 'node:worker_threads';
import { initialize } from '../engine/strategy.js';
import { engineHex, legalMoves } from './game.mjs';
// Upstream debug logging is per-node/per-move; silence it to avoid disk growth.
console.log = () => {};
const { ai_core, CoreAILogic } = await initialize();
const player = new ai_core.AIPlayer(0n);
const contexts = new Map();
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ id, board, ratio, gameId }) => {
  try {
    let logic = contexts.get(gameId);
    if (!logic) {
      if (contexts.size >= 16) contexts.delete(contexts.keys().next().value);
      contexts.set(gameId, logic = new CoreAILogic());
    }
    logic.time_limit_ratio = ratio;
    const hex = engineHex(board);
    const exponents = [...hex].map(x => parseInt(x, 16));
    const counts = Array(16).fill(0);
    exponents.forEach(v => counts[v]++);
    player.reset_board(BigInt(`0x${hex}`));
    const started = performance.now();
    const direction = logic.calculate_step(player, exponents, counts);
    // Never substitute a weaker algorithm or an arbitrary move on engine failure.
    if (!legalMoves(board).includes(direction)) throw Error(`上游 AI 返回无效方向 ${direction}，已暂停，棋盘保持不变。`);
    parentPort.postMessage({ id, direction, ms: Math.round(performance.now() - started),
      depth: logic.last_move === 'L3' ? null : logic.last_depth, source: logic.last_move === 'L3' ? '残局表' : '搜索',
      nodes: Number(player.node) });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
