#!/bin/bash
# Freeze the live wall into a static page with screenshots. Run from Zo before tearing the box down.
# Output: /home/workspace/Docs/walk-and-hack-wall/index.html + shots/*.png
set -e
OUT=/home/workspace/Docs/walk-and-hack-wall; mkdir -p "$OUT/shots"
curl -sf -H "Accept: application/json" https://walk.dweller.sh/wall.json > "$OUT/wall.json"
export AGENT_BROWSER_SESSION=wahfreeze
N=$(jq length "$OUT/wall.json"); echo "$N apps"
jq -c '.[]' "$OUT/wall.json" | nl -v0 | while IFS=$'\t' read -r i item; do
  link=$(echo "$item" | jq -r .link); id=$(echo "$link" | sed -E 's#https?://##; s#[^a-zA-Z0-9]+#-#g')
  agent-browser open "$link" >/dev/null 2>&1 || true; sleep 4
  agent-browser screenshot "$OUT/shots/$id.png" >/dev/null 2>&1 || echo "shot failed: $link"
done; agent-browser close >/dev/null 2>&1 || true
{
cat <<'H'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Walk & Hack: the wall</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--ink:#1b1b1b;--muted:#6b6b6b;--line:#d9d4c7;--paper:#faf7f0;--tw:#f22f46}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}main{max-width:1200px;margin:0 auto;padding:28px 20px 80px}h1{font-size:28px;margin:0}h1 span{color:var(--tw)}.sub{color:var(--muted);margin:4px 0 24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}.card{background:#fff;border:2px solid var(--line);border-radius:14px;overflow:hidden}.card img{width:100%;aspect-ratio:4/3;object-fit:cover;object-position:top;display:block;background:#eee}.meta{padding:12px 14px}.meta b{display:block;font-size:17px}.meta small{color:var(--muted)}.card.unnamed{opacity:.72;border-style:dashed}h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:28px 0 10px}</style></head>
<body><main><h1>Walk <span>&amp;</span> Hack: the wall</h1><p class="sub">Every app built by phone on Oct 24, 2026, AI Tinkerers NYC x Twilio. Frozen after the event; the sandboxes are gone, these are the last screenshots.</p>
H
for section in in out; do
  if [ "$section" = in ]; then sel='select(.submitted)'; head='<h2>Demo lineup</h2>'; else sel='select(.submitted|not)'; head='<h2>Also built today</h2>'; cls=' unnamed'; fi
  [ "$(jq "[.[]|$sel]|length" "$OUT/wall.json")" = 0 ] && continue
  echo "$head<div class=\"grid\">"
  jq -r ".[] | $sel | [.link, .title, (.name // \"\"), .builds] | @tsv" "$OUT/wall.json" | while IFS=$'\t' read -r link title name builds; do
    id=$(echo "$link" | sed -E 's#https?://##; s#[^a-zA-Z0-9]+#-#g')
    by=""; [ -n "$name" ] && by="by $name · "
    printf '<div class="card%s"><img src="shots/%s.png" alt=""><div class="meta"><b>%s</b><small>%s%s build%s</small></div></div>\n' "${cls:-}" "$id" "$(echo "$title" | sed 's/&/\&amp;/g;s/</\&lt;/g')" "$by" "$builds" "$([ "$builds" = 1 ] || echo s)"
  done
  echo '</div>'
done
echo '</main></body></html>'
} > "$OUT/index.html"
echo "frozen: $OUT/index.html"
