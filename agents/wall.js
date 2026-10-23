export function wallHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Walk &amp; Hack: the wall</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--ink:#1b1b1b;--muted:#6b6b6b;--line:#d9d4c7;--paper:#faf7f0;--card:#fff;--tw:#f22f46}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
  main{max-width:1200px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:28px;margin:0}h1 span{color:var(--tw)}
  .sub{color:var(--muted);margin:4px 0 24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
  .card{background:var(--card);border:2px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
  .card.building{border-color:var(--tw)}
  .frame{position:relative;aspect-ratio:4/3;background:#eee;overflow:hidden}
  .frame iframe{width:200%;height:200%;transform:scale(.5);transform-origin:0 0;border:0;pointer-events:none}
  .frame a{position:absolute;inset:0}
  .meta{padding:12px 14px}
  .meta b{display:block;font-size:17px}
  .meta small{color:var(--muted)}
  .pill{display:inline-block;font-size:11px;background:var(--tw);color:#fff;border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:2px}
  .pill.in{background:#1b7f4b}
  .card.unnamed{opacity:.72;border-style:dashed}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:28px 0 10px}
  h2 small{text-transform:none;letter-spacing:0;font-weight:400;margin-left:8px}
  .empty{color:var(--muted);padding:40px 0}
</style></head>
<body><main>
  <h1>Walk <span>&amp;</span> Hack: the wall</h1>
  <p class="sub">Every app built by phone today. Tap one to open it. Refreshes on its own.</p>
  <h2 id="h-in" hidden>Demo lineup <small>submitted: the builder texted their name</small></h2>
  <div id="grid-in" class="grid"></div>
  <h2 id="h-out" hidden>Also built today <small>text your name to the number to move yours up</small></h2>
  <div id="grid-out" class="grid"></div>
  <p id="empty" class="empty" hidden>Nothing built yet. Text the number.</p>
</main>
<script>
const cards=new Map();
function card(it){
  let c=cards.get(it.link);
  if(!c){c=document.createElement('div');c.className='card';
    c.innerHTML='<div class="frame"><iframe loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe><a target="_blank" rel="noopener"></a></div><div class="meta"><b></b><small></small></div>';
    c.querySelector('iframe').src=it.link;c.querySelector('a').href=it.link;cards.set(it.link,c);}
  c.className='card'+(it.building?' building':'')+(it.submitted?'':' unnamed');
  c.querySelector('b').innerHTML=esc(it.title)+(it.submitted?'<span class="pill in">in</span>':'')+(it.building?'<span class="pill">building</span>':'');
  c.querySelector('small').textContent=(it.name?'by '+it.name+' · ':'')+it.builds+' build'+(it.builds===1?'':'s');
  return c;
}
function place(grid,items){
  const want=items.map(card);
  const same=want.length===grid.children.length&&want.every((c,i)=>grid.children[i]===c);
  if(!same){for(const c of want) grid.appendChild(c);}
  for(const c of [...grid.children]) if(!want.includes(c)) c.remove();
}
async function load(){
  const r=await fetch('/wall.json',{headers:{Accept:'application/json'}});const items=await r.json();
  const ins=items.filter(i=>i.submitted),outs=items.filter(i=>!i.submitted);
  document.getElementById('empty').hidden=items.length>0;
  document.getElementById('h-in').hidden=ins.length===0;
  document.getElementById('h-out').hidden=outs.length===0;
  place(document.getElementById('grid-in'),ins);
  place(document.getElementById('grid-out'),outs);
  for(const k of [...cards.keys()]) if(!items.some(i=>i.link===k)) cards.delete(k);
}
function esc(s){return String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
load();setInterval(load,30000);
</script></body></html>`;
}
