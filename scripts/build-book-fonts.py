"""Build locally hosted OFL title font and a path-based Chinese wordmark."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.pens.svgPathPen import SVGPathPen
from io import BytesIO
import hashlib
root=Path(__file__).resolve().parents[1]
directory=root/'web/public/fonts'
source=directory/'ZCOOLXiaoWei-v1.ttf'
font=TTFont(source);available=set(font.getBestCmap())
critical='重异常之书写下你的冒险故事返回书页加入同行建立找回账号注册登录邀请玩家一体操作台角色档案技能卡册物资容器能力卡牌武器市场防具市场成员与账号公开模板库本团注册码消息历史收藏资料探索战斗团务更多规则名词聊天装备交易兑换券物品详情行动释放受击防守战利品当前房间新的旅程从这里开始'
common={n for n in available if n<256}|{ord(c) for c in critical if ord(c) in available}
remaining=sorted(available-common)
groups=[sorted(common)]+[remaining[i:i+64] for i in range(0,len(remaining),64)]
rules=[];sizes=[];generated=set()
for index,chars in enumerate(groups):
    part=TTFont(source);options=subset.Options();options.flavor='woff2'
    sub=subset.Subsetter(options=options);sub.populate(unicodes=chars);sub.subset(part);part.flavor='woff2'
    stream=BytesIO();part.save(stream);data=stream.getvalue();sizes.append(len(data))
    name='BookXiaoWei-'+hashlib.sha256(data).hexdigest()[:12]+'.woff2'
    (directory/name).write_bytes(data);generated.add(name)
    ranges=','.join('U+'+format(n,'X') for n in chars)
    family='BookXiaoWei' if index==0 else 'BookXiaoWeiExtended'
    rules.append('@font-face{font-family:'+family+';src:url("/fonts/'+name+'");font-display:swap;unicode-range:'+ranges+';}')
(root/'web/src/book-fonts.css').write_text('\n'.join(rules)+'\n',encoding='utf-8')
for old in directory.glob('BookXiaoWei-*.woff2'):
    if old.name not in generated:
        assert old.resolve().parent==directory.resolve();old.unlink()
assert sizes[0]<=60*1024
glyphs=font.getGlyphSet();cmap=font.getBestCmap();upm=font['head'].unitsPerEm
paths=[]
for n,c in enumerate('异常之书'):
    pen=SVGPathPen(glyphs);glyphs[cmap[ord(c)]].draw(pen)
    paths.append('<path transform="translate('+str(70+n*130)+' 155) scale('+str(125/upm)+' '+str(-125/upm)+')" d="'+pen.getCommands()+'"/>')
svg='''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 650 210"><title>异常之书</title><defs><linearGradient id="ink" x2=".2" y2="1"><stop stop-color="#fff5ff"/><stop offset=".45" stop-color="#d8d2ff"/><stop offset="1" stop-color="#a2d5f7"/></linearGradient></defs><g fill="none" stroke="#9d91d5" opacity=".7"><path d="M20 104H55M585 104H630M140 184H510"/><path d="M325 12l7 10-7 10-7-10zM325 176l7 8-7 8-7-8z"/><circle cx="30" cy="104" r="6"/><circle cx="620" cy="104" r="6"/></g><g fill="url(#ink)" stroke="#f5eaff" stroke-width="1">'''+''.join(paths)+'</g></svg>'
(root/'web/public/brand/book-wordmark-v1.svg').write_text(svg,encoding='utf-8')
print('Book font shards:',len(groups),'critical bytes:',sizes[0],'max supplemental:',max(sizes[1:]),'wordmark bytes:',len(svg.encode()))
