"""Build the compact parameter table embedded in the GP-10 web editor from gp10-address-map.json."""
import json, os
import sys

src, template, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src, encoding='utf-8'))

opts_index = {}
opts = []

def opt_id(lst):
    key = json.dumps(lst, ensure_ascii=False)
    if key not in opts_index:
        opts_index[key] = len(opts)
        opts.append(lst)
    return opts_index[key]

def a2i(s):
    v = 0
    for b in s.split():
        v = (v << 7) | int(b, 16)
    return v

def view(p):
    v = p['view']
    k = v['kind']
    if k == 'range':
        f = v['from']; st = v['step']
        f = int(f) if float(f).is_integer() else f
        st = int(st) if float(st).is_integer() else st
        return ['r', f, st, p['unit'] or '']
    if k == 'list':
        return ['l', opt_id(v['options'])]
    if k == 'pan':
        return ['pan']
    if k == 'balance':
        return ['bal']
    return ['x']

blocks = []
for b in d['patchBlocks']:
    params = []
    for p in b['params']:
        params.append([a2i(p['offset']), p['name'], p['min'], p['max'], p['size'], view(p)])
    blocks.append({'n': b['name'], 'a': [int(x, 16) for x in b['addr'].split()], 'len': b['length'], 'p': params})

setup = d['setupBlocks'][0]
data = {
    'src': d['source'],
    'opts': opts,
    'blocks': blocks,
}
js = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
html = open(template, encoding='utf-8').read()
assert '/*__GP10_DATA__*/null' in html
html = html.replace('/*__GP10_DATA__*/null', js)
usb_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'usbmidi.js'), encoding='utf-8').read()
assert '/*__USBMIDI__*/' in html and '</script' not in usb_js
html = html.replace('/*__USBMIDI__*/', usb_js.strip())
open(out, 'w', encoding='utf-8').write(html)
print('blocks', len(blocks), 'params', sum(len(b['p']) for b in blocks), 'option lists', len(opts), 'data bytes', len(js), 'html bytes', len(html))
