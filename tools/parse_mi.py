"""Parse BOSS GP-10 MIDI Implementation (pdftotext -layout output) into an address map JSON."""
import json
import re
import sys

src, dump_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src, encoding='utf-8').read().splitlines()

ROW = re.compile(r'^\|\s+([0-9A-F]{2}) ([0-9A-F]{2})\s*\|\s*([01a-z]{4} [01a-z]{4})\s*\|\s*(.+?)\s*\((-?\d+)\s*-\s*(-?\d+)\)\s*(?:offset:\s*(\d+))?\s*$')
CONT_BITS = re.compile(r'^\|\s*\|\s*([01a-z]{4} [01a-z]{4})\s*\|?\s*(.*)$')
CONT_TEXT = re.compile(r'^\|\s*\|\s*\|\s*(.*)$')
BLOCKROW = re.compile(r'^\|\s+([0-9A-F]{2}) ([0-9A-F]{2}) ([0-9A-F]{2})\s*\|\s*(.+?)\s*$')
SECTION = re.compile(r'^\* (.+?) Parameters Offset Address\s*$')

# 1) block tables (Setup / System / Patch)
blocks = {'Setup': [], 'System': [], 'Patch': []}
cur_table = None
for ln in lines:
    m = re.match(r'^\* (Setup|System|Patch)\s*$', ln)
    if m:
        cur_table = m.group(1)
        continue
    if cur_table:
        if ln.startswith('* '):
            cur_table = None
            continue
        b = BLOCKROW.match(ln)
        if b:
            blocks[cur_table].append({'offset': [int(b.group(i), 16) for i in (1, 2, 3)], 'name': b.group(4).strip()})

# 2) parameter sections
sections = {}
cur = None
for ln in lines:
    s = SECTION.match(ln)
    if s:
        cur = s.group(1).strip()
        sections[cur] = []
        continue
    if cur is None:
        continue
    r = ROW.match(ln)
    if r:
        bits = r.group(3)
        sections[cur].append({
            'offset': [int(r.group(1), 16), int(r.group(2), 16)],
            'name': re.sub(r'\s{2,}', ' ', r.group(4)).strip(),
            'min': int(r.group(5)), 'max': int(r.group(6)),
            'valueOffset': int(r.group(7)) if r.group(7) else None,
            'bits': [bits], 'desc': [],
        })
        continue
    if not sections[cur]:
        continue
    p = sections[cur][-1]
    c = CONT_BITS.match(ln)
    if c:
        p['bits'].append(c.group(1))
        if c.group(2).strip():
            p['desc'].append(c.group(2).strip())
        continue
    t = CONT_TEXT.match(ln)
    if t and t.group(1).strip():
        p['desc'].append(re.sub(r'\s{2,}', ' ', t.group(1).strip()))

def a2i(a):
    v = 0
    for b in a:
        v = (v << 7) | b
    return v

def i2a(v, n=4):
    out = []
    for _ in range(n):
        out.append(v & 0x7F)
        v >>= 7
    return out[::-1]

hx = lambda a: ' '.join('%02X' % x for x in a)

def interpret(p):
    """Derive a display model from the description text."""
    desc = ' '.join(p['desc']).strip()
    p['display'] = desc
    nbytes = len(p['bits'])
    p['size'] = nbytes
    # nibble encoding: every row is '0000 xxxx' style -> 4 bits per byte
    p['encoding'] = 'nibble' if nbytes > 1 else '7bit'
    count = p['max'] - p['min'] + 1
    unit = None
    mu = re.search(r'\[([^\]]+)\]\s*$', desc)
    if mu:
        unit = mu.group(1)
    body = re.sub(r'\s*\[[^\]]+\]\s*$', '', desc)
    p['unit'] = unit if unit and unit != 'SIGNED' else None
    m = re.fullmatch(r'(-?\+?\d+(?:\.\d+)?)\s*-\s*(-?\+?\d+(?:\.\d+)?)', body)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        span = p['max'] - p['min']
        step = (b - a) / span if span else 1
        p['view'] = {'kind': 'range', 'from': a, 'to': b, 'step': round(step, 6)}
        return
    opts = [o.strip() for o in re.split(r',\s*', body) if o.strip()]
    if len(opts) == count:
        p['view'] = {'kind': 'list', 'options': opts}
        return
    # pan style: L100 - CENTER - R100
    # pan style: L100 - CENTER - R100 over 0-100 (2 per step, 50 = CENTER)
    if re.fullmatch(r'L100\s*-\s*CENTER\s*-\s*R100', body) and (p['min'], p['max']) == (0, 100):
        p['view'] = {'kind': 'pan', 'center': 50, 'scale': 2}
        return
    # mixer balance: M0:100N - M100:100N - M100:0N over 0-100 (50 = M100:100N)
    if re.fullmatch(r'M0:100N\s*-\s*M100:100N\s*-\s*M100:0N', body) and (p['min'], p['max']) == (0, 100):
        p['view'] = {'kind': 'balance', 'center': 50, 'scale': 2}
        return
    # mixed: numeric ranges and labels, e.g. "0 - 100, WHL, 2THd" or "OFF, 1 - 10"
    expanded = []
    for tok in opts:
        r = re.fullmatch(r'(-?\d+)\s*-\s*(-?\d+)', tok)
        if r:
            a, b = int(r.group(1)), int(r.group(2))
            stepv = 1 if b >= a else -1
            expanded += [str(v) for v in range(a, b + stepv, stepv)]
        else:
            expanded.append(tok)
    if len(expanded) == count:
        p['view'] = {'kind': 'list', 'options': expanded}
        return
    p['view'] = {'kind': 'raw'}

patch_base = [0x20, 0x00, 0x00, 0x00]
out_blocks = []
for blk in blocks['Patch']:
    params = sections.get(blk['name'], [])
    entries = []
    for p in params:
        interpret(p)
        absaddr = i2a(a2i(patch_base) + a2i(blk['offset']) + a2i(p['offset']))
        entries.append({
            'addr': hx(absaddr), 'offset': hx(p['offset']), 'name': p['name'],
            'min': p['min'], 'max': p['max'], 'size': p['size'], 'encoding': p['encoding'],
            'display': p['display'], 'unit': p['unit'], 'view': p['view'], 'valueOffset': p['valueOffset'],
        })
    length = (a2i(params[-1]['offset']) + params[-1]['size']) if params else 0
    out_blocks.append({'name': blk['name'], 'offset': hx(blk['offset']),
                       'addr': hx(i2a(a2i(patch_base) + a2i(blk['offset']))), 'length': length, 'params': entries})

# System / Setup blocks too
def build(table, base):
    res = []
    for blk in blocks[table]:
        key = re.sub(r'\s*\(\s*\d+\)\s*$', '', blk['name'])
        params = sections.get(blk['name']) or sections.get(key) or []
        entries = []
        for p in params:
            interpret(p)
            entries.append({'addr': hx(i2a(a2i(base) + a2i(blk['offset']) + a2i(p['offset']))), 'offset': hx(p['offset']),
                            'name': p['name'], 'min': p['min'], 'max': p['max'], 'size': p['size'], 'encoding': p['encoding'],
                            'display': p['display'], 'unit': p['unit'], 'view': p['view'], 'valueOffset': p['valueOffset']})
        length = (a2i(params[-1]['offset']) + params[-1]['size']) if params else 0
        res.append({'name': blk['name'], 'offset': hx(blk['offset']), 'addr': hx(i2a(a2i(base) + a2i(blk['offset']))), 'length': length, 'params': entries})
    return res

system_blocks = build('System', [0x10, 0, 0, 0])
setup_blocks = build('Setup', [0, 0, 0, 0])

# 3) verify block lengths against the live dump the user captured
observed = {}
for ln in open(dump_path, encoding='utf-8'):
    m = re.match(r'^Block ([0-9A-F ]{11})（(\d+)バイト', ln.strip())
    if m:
        observed[m.group(1)] = int(m.group(2))
mismatch = []
for b in out_blocks:
    o = observed.get(b['addr'])
    b['observedLength'] = o
    if o != b['length']:
        mismatch.append((b['addr'], b['name'], b['length'], o))

total = sum(len(b['params']) for b in out_blocks)
print('patch blocks:', len(out_blocks), 'params:', total, 'system params:', sum(len(b['params']) for b in system_blocks))
print('blocks with observed length:', sum(1 for b in out_blocks if b['observedLength'] is not None))
print('length mismatches:', mismatch)
views = {}
for b in out_blocks:
    for p in b['params']:
        views[p['view']['kind']] = views.get(p['view']['kind'], 0) + 1
print('view kinds:', views)
raws = [(b['name'], p['name'], p['display'][:70]) for b in out_blocks for p in b['params'] if p['view']['kind'] == 'raw']
print('raw examples (%d):' % len(raws))
for r in raws[:25]:
    print('  ', r)

doc = {
    'format': 'gp10-address-map', 'version': 2,
    'source': 'BOSS GP-10 MIDI Implementation Ver.1.01 (Dec. 26th, 2014) を機械抽出。ブロック長は実機ダンプで照合',
    'device': {'name': 'BOSS GP-10', 'deviceId': '10', 'modelId': '00 00 00 05', 'identityFamily': '05 03'},
    'layout': {
        'setup': '00 00 00 00', 'system': '10 00 00 00', 'tempPatch': '20 00 00 00',
        'userPatch': 'User p (1-99) = 20 00 00 00 + (4p << 14)、つまり2バイト目を4pずつ進める（7ビット繰り上がり）。User 1 = 20 04 00 00、User 99 = 23 0C 00 00',
        'programChange': 'B0 00 00 / B0 20 00 / C0 (p-1)',
        'nibbleEncoding': 'size>1 の項目は1バイト4ビットずつ上位から並ぶ（例: 3バイト = aaaa bbbb cccc）',
    },
    'setupBlocks': setup_blocks,
    'systemBlocks': system_blocks,
    'patchBlocks': out_blocks,
}
json.dump(doc, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('written', out_path)
