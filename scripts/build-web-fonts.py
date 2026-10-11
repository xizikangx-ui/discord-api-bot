"""Optional asset build: pip install fonttools brotli. Runtime needs neither."""
from pathlib import Path
from collections import Counter
from fontTools.ttLib import TTFont
from fontTools import subset
import hashlib
root = Path(__file__).resolve().parents[1]
directory = root / 'web/public/fonts'
source = directory / 'MaShanZheng-v1.ttf'
font = TTFont(source)
available = set(font.getBestCmap())
texts = ''.join(p.read_text(encoding='utf-8') for p in (root/'web/src').glob('*.jsx'))
common = {n for n in available if n < 256} | {ord(c) for c, _ in Counter(c for c in texts if 0x3400 <= ord(c) <= 0x9fff).most_common(192)}
remaining = sorted(available - common)
groups = [sorted(common)] + [remaining[i:i+256] for i in range(0, len(remaining), 256)]
rules = []
for chars in groups:
    part = TTFont(source)
    options = subset.Options()
    options.flavor = 'woff2'
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=chars)
    sub.subset(part)
    part.flavor = 'woff2'
    from io import BytesIO
    stream = BytesIO()
    part.save(stream)
    data = stream.getvalue()
    name = 'MaShanZheng-' + hashlib.sha256(data).hexdigest()[:12] + '.woff2'
    (directory/name).write_bytes(data)
    ranges = ','.join('U+'+format(n, 'X') for n in chars)
    rules.append('@font-face{font-family:MaShanZheng;src:url("/fonts/'+name+'");font-display:swap;unicode-range:'+ranges+';}')
(root/'web/src/art-fonts.css').write_text('\n'.join(rules)+'\n', encoding='utf-8')
print('WOFF2 shards:', len(groups), 'largest bytes:', max(p.stat().st_size for p in directory.glob('*.woff2')))
