#!/bin/bash
# Posts ops/primer-post.md to the Walk & Hack event message board (emails all attendees). Idempotent via marker.
set -e
cd "$(dirname "$0")"
MARK=.primer-posted
[ -f "$MARK" ] && { echo "already posted: $(cat $MARK)"; exit 0; }
K="${AITINKERERS_API_KEY:-$AIT_API_KEY}"; [ -n "$K" ] || { echo "no AIT key"; exit 1; }
BODY=$(jq -n --arg c "$(cat primer-post.md)" '{board_key:"meetup_mu_pjQUTmNNb90", title:"Tomorrow: where to meet, the number, and the 12:30 Boathouse circle", content:$c}')
if [ -n "$DRY" ]; then echo "$BODY" | jq -c "{board_key,title,len:(.content|length)}"; exit 0; fi
RES=$(curl -s -H "Authorization: Bearer $K" -H "content-type: application/json" https://aitinkerers.org/api/agents/v1/message_boards/posts/create -d "$BODY")
echo "$RES" | jq -c '{ok, error, post:(.data.post.post_token // .data.post_token // null)}'
echo "$RES" | jq -e '.ok==true' >/dev/null && echo "$(date -u +%FT%TZ) $(echo "$RES" | jq -r '.data.post.post_token // .data.post_token // "posted"')" > "$MARK"
