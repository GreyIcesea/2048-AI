// Offline benchmark; uses the same engine and standard random spawning, never the website DB.
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine } from '../lib/ai.mjs';
import { newBoard, applyMove } from '../lib/game.mjs';
const engine = new Engine();
const started=Date.now();
const strength=Number(process.env.STRENGTH || 0.25);
mkdirSync(new URL('../test-results/',import.meta.url),{recursive:true});
const g={id:'validation-run',board:newBoard(),score:0,maxTile:0,steps:0,version:0,status:'active',strength};
try {
  while(!engine.ready)await new Promise(r=>setTimeout(r,100));
  while(g.status==='active') {
    const result=await engine.calculate(g);applyMove(g,result.direction);
    if(g.steps%100===0){console.log(JSON.stringify({steps:g.steps,score:g.score,maxTile:g.maxTile,elapsedSeconds:Math.round((Date.now()-started)/1000),rssMB:Math.round(process.memoryUsage().rss/1048576)}));writeFileSync(new URL('../test-results/benchmark-progress.json',import.meta.url),JSON.stringify(g,null,2));}
  }
  const report={...g,elapsedSeconds:Math.round((Date.now()-started)/1000),rssMB:Math.round(process.memoryUsage().rss/1048576),note:'One genuine full game is a functional check, not a success-rate estimate.'};
  writeFileSync(new URL('../test-results/benchmark.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await engine.close();}
