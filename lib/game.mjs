import { randomInt } from 'node:crypto';

// Real tile values, not the engine's 4-bit abstraction. 32768+32768 is 65536.
export function slide(board, direction) {
  if (![1, 2, 3, 4].includes(direction)) throw Error('无效方向');
  const next = board.slice();
  let gained = 0;
  for (let line = 0; line < 4; line++) {
    const ids = Array.from({ length: 4 }, (_, k) => direction === 1 ? line * 4 + k
      : direction === 2 ? line * 4 + 3 - k : direction === 3 ? k * 4 + line : (3 - k) * 4 + line);
    const values = ids.map(i => board[i]).filter(Boolean);
    const result = [];
    for (let k = 0; k < values.length; k++) {
      if (values[k] === values[k + 1]) { result.push(values[k] * 2); gained += values[k] * 2; k++; }
      else result.push(values[k]);
    }
    ids.forEach((i, k) => { next[i] = result[k] || 0; });
  }
  return { board: next, gained, changed: next.some((v, i) => v !== board[i]) };
}
export function spawn(board, rng = randomInt) {
  const empty = board.map((v, i) => v ? -1 : i).filter(i => i >= 0);
  if (!empty.length) return null;
  const index = empty[rng(empty.length)];
  const value = rng(10) === 0 ? 4 : 2;
  board[index] = value;
  return { index, value };
}
export function newBoard() { const b = Array(16).fill(0); spawn(b); spawn(b); return b; }
export function legalMoves(board) { return [1, 2, 3, 4].filter(d => slide(board, d).changed); }
export function applyMove(game, direction, rng = randomInt) {
  const result = slide(game.board, direction);
  if (!result.changed) return false;
  game.board = result.board;
  game.spawn = spawn(game.board, rng);
  game.score += result.gained;
  game.steps++;
  game.maxTile = Math.max(game.maxTile || 0, ...game.board);
  for (const tile of [8192, 16384, 32768, 65536]) game[`reached${tile}`] = game.maxTile >= tile;
  game.version++;
  game.lastDirection = direction;
  if (!legalMoves(game.board).length) { game.status = 'finished'; game.running = false; game.endedAt = new Date().toISOString(); }
  return true;
}
export function engineHex(board) { return board.map(v => v ? Math.min(15, Math.log2(v)).toString(16) : '0').join(''); }
