#!/usr/bin/env python3
"""Reads ROADMAP.md and writes ROADMAP.html, the published board.

One source, two outputs, so the board and the file cannot drift. The script
refuses to write anything it could not parse cleanly - a board that silently
drops an item is worse than no board, because you would plan around the gap
without knowing it was there.

    python scripts/roadmap.py
"""

import html
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'ROADMAP.md')
TARGET = os.path.join(ROOT, 'ROADMAP.html')

STATUS_ORDER = ['Now', 'Next', 'Later', 'Someday', 'Done', 'Rejected']

# Areas in the order they should read on the board, with a one-line gloss.
AREA_BLURB = {
    'COL': 'What the collector fetches, and what it costs to fetch it.',
    'MKT': 'What the numbers mean, and whether they mean it honestly.',
    'CLS': 'What counts as a sovereign — the question everything else rests on.',
    'UI':  'The dashboard, judged by whether a decision can be made from it.',
    'OPS': 'Repo, deploy and the traps worth never falling into twice.',
}


def parse(md):
    """Pull every table row out of the markdown, keeping its area heading."""
    items = []
    area = None
    area_title = None
    for line in md.split('\n'):
        head = re.match(r'^##\s+([A-Z]{2,4})\s+—\s+(.+?)\s*$', line)
        if head:
            area, area_title = head.group(1), head.group(2)
            continue
        if not line.startswith('|'):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) != 6:
            continue
        if cells[0] in ('ID', '---') or set(cells[0]) <= {'-', ' '}:
            continue
        if not re.match(r'^[A-Z]{2,4}-\d{2}$', cells[0]):
            raise SystemExit('roadmap.py: not an item id: %r' % cells[0])
        if cells[2] not in STATUS_ORDER:
            raise SystemExit('roadmap.py: unknown status %r on %s' % (cells[2], cells[0]))
        items.append({
            'id': cells[0], 'item': cells[1], 'status': cells[2],
            'size': cells[3], 'blocked': cells[4], 'why': cells[5],
            'area': area, 'area_title': area_title,
        })
    if not items:
        raise SystemExit('roadmap.py: parsed no items — refusing to write an empty board')
    return items


def standfirst(md):
    m = re.search(r'^## Where things stand — (.+?)$(.*?)^---', md, re.S | re.M)
    if not m:
        raise SystemExit('roadmap.py: no "Where things stand" section')
    return m.group(1).strip(), m.group(2).strip()


def inline(text):
    """The small subset of markdown these cells actually use."""
    out = html.escape(text)
    out = re.sub(r'`([^`]+)`', r'<code>\1</code>', out)
    out = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', out)
    out = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', out)
    out = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', out)
    return out


def render(items, as_of, intro):
    counts = {s: sum(1 for i in items if i['status'] == s) for s in STATUS_ORDER}
    open_items = [i for i in items if i['status'] in ('Now', 'Next')]

    parts = []
    for area in ('COL', 'MKT', 'CLS', 'UI', 'OPS'):
        rows = [i for i in items if i['area'] == area]
        if not rows:
            continue
        rows.sort(key=lambda r: (STATUS_ORDER.index(r['status']), r['id']))
        title = html.escape(rows[0]['area_title'])
        body = '\n'.join(
            '<tr class="s-{cls}">'
            '<td class="id">{id}</td>'
            '<td class="what">{item}</td>'
            '<td><span class="pill p-{cls}">{status}</span></td>'
            '<td class="sz">{size}</td>'
            '<td class="blk">{blocked}</td>'
            '<td class="why">{why}</td>'
            '</tr>'.format(
                cls=r['status'].lower(), id=html.escape(r['id']),
                item=inline(r['item']), status=html.escape(r['status']),
                size=html.escape(r['size']) or '&mdash;',
                blocked=inline(r['blocked']) or '&mdash;',
                why=inline(r['why']))
            for r in rows)
        parts.append(
            '<section class="area">'
            '<div class="area-head"><h2>{a}</h2><p class="area-sub">{t}</p></div>'
            '<p class="blurb">{b}</p>'
            '<div class="scroll"><table>'
            '<thead><tr><th>ID</th><th>Item</th><th>Status</th><th>Size</th>'
            '<th>Blocked by</th><th>Why / evidence</th></tr></thead>'
            '<tbody>{rows}</tbody></table></div></section>'.format(
                a=html.escape(area), t=title,
                b=html.escape(AREA_BLURB.get(area, '')), rows=body))

    return TEMPLATE.format(
        as_of=html.escape(as_of),
        intro='\n'.join('<p>%s</p>' % inline(p.strip())
                        for p in intro.split('\n\n') if p.strip()),
        now=counts['Now'], next=counts['Next'], later=counts['Later'],
        done=counts['Done'], rejected=counts['Rejected'],
        open_ids=' · '.join(html.escape(i['id']) for i in open_items) or '&mdash;',
        areas='\n'.join(parts))


TEMPLATE = """<title>Coin Market Roadmap</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&display=swap">
<style>
  :root {{
    --paper:#f9f9f7; --card:#ffffff; --ink:#0b0b0b; --ink-2:#52514e; --muted:#8b8983;
    --rule:#e3e2db; --rule-soft:#efeee8;
    --now:#b8471f; --next:#2a5fb8; --later:#6a6862; --someday:#8b8983;
    --done:#1f6b33; --rejected:#9a2f2f; --metal:#9a6f1e;
    --chip:rgba(11,11,11,0.05);
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --paper:#0d0d0d; --card:#17171a; --ink:#f4f4f2; --ink-2:#b9b8b2; --muted:#86847e;
      --rule:#2b2b2e; --rule-soft:#202023;
      --now:#f08a52; --next:#6ba4f0; --later:#9a9892; --someday:#86847e;
      --done:#4fb166; --rejected:#e0736a; --metal:#d3a445;
      --chip:rgba(255,255,255,0.07);
    }}
  }}
  :root[data-theme="dark"] {{
    --paper:#0d0d0d; --card:#17171a; --ink:#f4f4f2; --ink-2:#b9b8b2; --muted:#86847e;
    --rule:#2b2b2e; --rule-soft:#202023;
    --now:#f08a52; --next:#6ba4f0; --later:#9a9892; --someday:#86847e;
    --done:#4fb166; --rejected:#e0736a; --metal:#d3a445;
    --chip:rgba(255,255,255,0.07);
  }}
  * {{ box-sizing:border-box }}
  body {{
    margin:0; background:var(--paper); color:var(--ink);
    font-family:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased;
  }}
  .wrap {{ max-width:1180px; margin:0 auto; padding:52px 22px 88px }}
  h1,h2,.eyebrow,.pill,.id {{ font-family:Archivo,ui-sans-serif,system-ui,sans-serif }}
  code,.id,.sz,.tally b {{ font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace }}
  .eyebrow {{ font-size:11.5px; font-weight:600; letter-spacing:.14em; text-transform:uppercase;
    color:var(--muted); margin:0 0 10px }}
  h1 {{ font-size:clamp(28px,4.4vw,40px); font-weight:700; letter-spacing:-.02em;
    line-height:1.08; margin:0 0 16px; text-wrap:balance }}
  .intro p {{ color:var(--ink-2); margin:0 0 12px; max-width:74ch; font-size:15.5px }}
  .intro strong {{ color:var(--ink); font-weight:500 }}
  .tally {{ display:flex; flex-wrap:wrap; gap:0; margin:30px 0 6px;
    border-top:1px solid var(--rule); border-bottom:1px solid var(--rule) }}
  .tally div {{ padding:15px 20px; border-left:1px solid var(--rule-soft) }}
  .tally div:first-child {{ border-left:0; padding-left:0 }}
  .tally b {{ display:block; font-size:23px; font-weight:500; letter-spacing:-.02em;
    font-variant-numeric:tabular-nums }}
  .tally span {{ font-size:11.5px; color:var(--muted) }}
  .open {{ font-size:13px; color:var(--ink-2); margin:12px 0 0 }}
  .open code {{ background:var(--chip); padding:1px 6px; border-radius:3px; font-size:12.5px }}
  .area {{ margin-top:52px }}
  .area-head {{ display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;
    border-bottom:2px solid var(--ink); padding-bottom:9px }}
  .area-head h2 {{ font-size:19px; font-weight:700; letter-spacing:.02em; margin:0 }}
  .area-sub {{ margin:0; font-size:14px; color:var(--ink-2) }}
  .blurb {{ font-size:13.5px; color:var(--muted); margin:11px 0 14px; max-width:74ch }}
  .scroll {{ overflow-x:auto }}
  table {{ width:100%; border-collapse:collapse; font-size:13.5px; min-width:900px }}
  th {{ text-align:left; font-weight:500; font-size:11.5px; letter-spacing:.06em;
    text-transform:uppercase; color:var(--muted);
    border-bottom:1px solid var(--rule); padding:0 14px 8px 0; white-space:nowrap }}
  td {{ padding:13px 14px 13px 0; border-bottom:1px solid var(--rule-soft);
    color:var(--ink-2); vertical-align:top }}
  .id {{ font-size:12.5px; color:var(--ink); white-space:nowrap; font-weight:500 }}
  .what {{ color:var(--ink); min-width:210px }}
  .sz {{ color:var(--muted); text-align:center; font-size:12.5px }}
  .blk {{ font-size:12.5px; color:var(--muted); max-width:130px }}
  .why {{ font-size:12.5px; line-height:1.55; min-width:300px }}
  tr.s-done .what, tr.s-rejected .what {{ color:var(--ink-2) }}
  tr.s-rejected .why {{ color:var(--ink-2) }}
  .pill {{ display:inline-block; font-size:10.5px; font-weight:600; letter-spacing:.08em;
    text-transform:uppercase; padding:3px 8px; border-radius:3px;
    background:var(--chip); white-space:nowrap }}
  .p-now {{ color:var(--now) }} .p-next {{ color:var(--next) }}
  .p-later {{ color:var(--later) }} .p-someday {{ color:var(--someday) }}
  .p-done {{ color:var(--done) }} .p-rejected {{ color:var(--rejected) }}
  code {{ font-size:12px; background:var(--chip); padding:1px 5px; border-radius:3px }}
  a {{ color:var(--next); text-underline-offset:3px }}
  a:focus-visible {{ outline:2px solid var(--next); outline-offset:3px }}
  footer {{ margin-top:60px; padding-top:18px; border-top:1px solid var(--rule);
    font-size:12.5px; color:var(--muted) }}
</style>
<div class="wrap">
  <p class="eyebrow">Coin&#8209;Market &middot; status board &middot; {as_of}</p>
  <h1>What is being built, and in what order</h1>
  <div class="intro">{intro}</div>

  <div class="tally">
    <div><b>{now}</b><span>Now</span></div>
    <div><b>{next}</b><span>Next</span></div>
    <div><b>{later}</b><span>Later</span></div>
    <div><b>{done}</b><span>Done</span></div>
    <div><b>{rejected}</b><span>Rejected</span></div>
  </div>
  <p class="open">Open right now: <code>{open_ids}</code> &mdash; point at an ID and any session
  can find it.</p>

  {areas}

  <footer>
    Generated from <code>ROADMAP.md</code> by <code>scripts/roadmap.py</code>. The reasoning behind
    every row lives in <code>HANDOVER.md</code>. IDs are permanent: a dropped item becomes
    <em>Rejected</em>, never a gap.
  </footer>
</div>
"""


def main():
    md = io.open(SOURCE, encoding='utf-8').read()
    items = parse(md)
    as_of, intro = standfirst(md)
    out = render(items, as_of, intro)

    # Refuse to write markup that is obviously unbalanced - the generator is
    # only worth having if it fails loudly.
    for tag in ('table', 'tbody', 'section', 'div'):
        if out.count('<%s' % tag) != out.count('</%s>' % tag):
            raise SystemExit('roadmap.py: unbalanced <%s> — not writing' % tag)

    io.open(TARGET, 'w', encoding='utf-8', newline='').write(out)
    print('roadmap.py: %d items across %d areas -> ROADMAP.html'
          % (len(items), len({i['area'] for i in items})))


if __name__ == '__main__':
    sys.exit(main())
