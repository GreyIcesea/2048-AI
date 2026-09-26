import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { applyMove, slide, spawn, legalMoves, engineHex } from '../lib/game.mjs';
import { initialize } from '../engine/strategy.js';
const board = row => [...row,...Array(12).fill(0)];
test('each tile merges only once per move; score is sum of produced tiles',()=>{
  const a=slide(board([2,2,2,2]),1);assert.deepEqual(a.board.slice(0,4),[4,4,0,0]);assert.equal(a.gained,8);
  assert.deepEqual(slide(board([2,2,4,0]),1).board.slice(0,4),[4,4,0,0]);
  assert.deepEqual(slide(board([2,0,2,4]),2).board.slice(0,4),[0,0,4,4]);
  assert.equal(slide(board([2,0,0,0]),1).changed,false);
});
test('real game merges 32768 into 65536 and continues beyond engine abstraction',()=>{
  const g={board:board([32768,32768,0,0]),score:0,steps:0,version:0,status:'active'};
  applyMove(g,1,n=>n-1);assert.equal(g.board[0],65536);assert.equal(g.score,65536);assert.equal(g.reached65536,true);assert.equal(g.steps,1);
  assert.equal(engineHex(g.board)[0],'f');assert.equal(g.board[0],65536);
});
test('no spawn or RNG call on an invalid move',()=>{
  const g={board:board([2,0,0,0]),score:0,steps:0,version:0,status:'active'};
  assert.equal(applyMove(g,1,()=>{throw Error('RNG must not run');}),false);assert.equal(g.steps,0);
});
test('spawn selects only empty cells; exactly 1/10 value branches produce a four',()=>{
  for(let value=0;value<10;value++){const b=Array(16).fill(8);b[7]=0;let calls=0;spawn(b,n=>calls++===0?0:value);assert.equal(b[7],value===0?4:2);assert.equal(calls,2);}
});
test('terminal detection is independent of reaching 2048',()=>{
  const b=[2,4,2,4,4,2,4,2,2,4,2,4,4,2,4,2];assert.deepEqual(legalMoves(b),[]);
  b[0]=2048;b[1]=2048;assert.ok(legalMoves(b).length);
});
test('rules agree with upstream native WASM mover on 500 random boards in all directions',async()=>{
  const {ai_core}=await initialize();
  for(let k=0;k<500;k++){
    const b=Array.from({length:16},()=>{const p=randomInt(0,13);return p?2**p:0;});
    for(const d of [1,2,3,4])assert.equal(BigInt('0x'+engineHex(slide(b,d).board)),ai_core.move_board(BigInt('0x'+engineHex(b)),d));
  }
});
