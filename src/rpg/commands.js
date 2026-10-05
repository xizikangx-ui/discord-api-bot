'use strict';
const { SlashCommandBuilder: Slash, PermissionFlagsBits: P } = require('discord.js');
const C = require('./constants');
const choices = values => values.map(v => typeof v === 'string' ? { name: v, value: v } : v);
const cmd = (name, description) => new Slash().setName(name).setDescription(description).setDMPermission(false);
const user = (s, required = true, name = '成员') => s.addUserOption(o => o.setName(name).setDescription('选择成员').setRequired(required));
const str = (s, name, description, required = true, values) => s.addStringOption(o => {
  o.setName(name).setDescription(description).setRequired(required);
  if (values) o.addChoices(...choices(values));
  return o;
});
const int = (s, name, description, required = true, min = 0, max = 1000000) =>
  s.addIntegerOption(o => o.setName(name).setDescription(description).setRequired(required).setMinValue(min).setMaxValue(max));
const item = (s, name = '物品', required = true) => s.addStringOption(o => o.setName(name).setDescription('背包实例或模板编号，可自动搜索').setRequired(required).setAutocomplete(true));
function commands() {
  const list = [
    cmd('跑团配置面板', '配置GM、玩家、公告和领取身份组面板').setDefaultMemberPermissions(P.ManageGuild),
    str(str(cmd('rd', '掷骰，默认1d100'), '骰式', '如r2d20、1d100或1d10+2', false), '模式', '普通、优势或劣势', false,
      [{ name: '普通', value: 'normal' }, { name: '优势', value: 'advantage' }, { name: '劣势', value: 'disadvantage' }]),
    str(cmd('建卡', '生成或继续待确认角色卡'), '名字', '角色名', false),
    user(cmd('角色卡', '公开查看角色属性、等级和生命'), false),
    int(str(cmd('分配属性点', '为自己的角色分配自由属性点'), '属性', '选择属性', true,
      Object.entries(C.ATTRIBUTES).map(([value, name]) => ({ name, value }))), '点数', '增加的点数', false, 1, 100000),
    cmd('抽卡', '消耗一次抽卡次数；超重时保留待领取结果'),
    str(cmd('开箱', '消耗对应箱型次数，领取一件现代物品'), '箱型', '要开启的箱子', true, C.BOXES),
    user(cmd('背包', '私密查看自己的资产；GM可查看他人'), false),
    int(item(cmd('丢弃', '确认后丢弃自己的未装备物品')), '数量', '丢弃数量', false, 1, 100000),
    item(str(item(cmd('装备', '装备、卸下、装配、拆下或扩展槽位')), '操作', '操作类型', true,
      ['装备', '卸下', '装配', '拆下', '使用道具', '使用世界树之心-头部', '使用世界树之心-身体', '使用世界树之心-戒指', '使用世界树之泪']), '配件', false),
    user(cmd('交易', '与另一位玩家交换物品及游戏币')),
    int(user(cmd('转账', '向另一位玩家转账，发送方确认后到账')), '金额', '转账金额', true, 1, C.MAX_MONEY),
    str(cmd('录入物品', 'GM分步录入物品、装备、卡牌或技能'), '类型', '模板种类', false, C.ITEM_KINDS),
    cmd('录入词条', 'GM录入结构化词条或展示文字'),
    cmd('录入异常', 'GM录入异常、各级效果与恶化规则'),
    str(cmd('规则', '跑团规则、公式及示例'), '章节', '速查章节', false, ['总览', '建卡', '升级', '负重', '装备', '交易', '抽取', '战斗', '异常', '指令']),
  ];
  const gm = cmd('gm', 'GM发放、收购、销卡、模板和NPC管理');
  gm.addSubcommand(s => int(user(s.setName('经验').setDescription('发放经验，自动应用适应性与升级')), '数量', '基础经验', true, 1, 1000000000));
  gm.addSubcommand(s => int(user(s.setName('属性点').setDescription('额外发放自由属性点')), '数量', '点数', true, 1, 100000));
  gm.addSubcommand(s => int(item(user(s.setName('发放').setDescription('发放模板物品或技能'))), '数量', '发放数量', false, 1, 100));
  gm.addSubcommand(s => int(str(user(s.setName('次数').setDescription('发放抽卡或指定箱型次数')), '类型', '抽卡或箱型', true, ['抽卡', ...C.BOXES]), '数量', '发放次数', true, 1, 100000));
  gm.addSubcommand(s => int(int(item(user(s.setName('收购').setDescription('向玩家报价，玩家确认后移除物品并入账'))), '价格', '收购总价', true, 0, C.MAX_MONEY), '数量', '收购数量', false, 1, 100000));
  gm.addSubcommand(s => user(s.setName('销卡').setDescription('确认后清空角色与财产，保留审计')));
  gm.addSubcommand(s => s.setName('npc').setDescription('创建或继续NPC模板草稿'));
  gm.addSubcommand(s => str(s.setName('草稿').setDescription('恢复自己的持久录入草稿'), '编号', '草稿编号', false));
  gm.addSubcommand(s => item(s.setName('修改模板').setDescription('保留编号发布新版本；已发放实例不变')));
  gm.addSubcommand(s => str(s.setName('模板库').setDescription('查看物品、词条、异常和NPC模板'), '类型', '模板分类', false, ['物品', '词条', '异常', 'NPC']));
  gm.addSubcommand(s => s.setName('恢复存档').setDescription('重新读取加密存档，核对不明确写入结果'));
  list.push(gm);
  const battle = cmd('战斗', 'GM招募、战斗操作与玩家个人面板');
  battle.addSubcommand(s => str(int(int(str(s.setName('招募').setDescription('在当前频道发布战斗招募'), '名称', '战斗名称'),
    '列数', '地图列数，默认10', false, 1, 20), '行数', '地图行数，默认10', false, 1, 20), '场景', '场景说明', false));
  battle.addSubcommand(s => str(s.setName('开战').setDescription('锁定阵容并自动轮换行动'), '偷袭', 'GM确认偷袭阵营', false,
    [{ name: '友方', value: 'ally' }, { name: '敌方', value: 'enemy' }]));
  battle.addSubcommand(s => str(s.setName('面板').setDescription('查看战场或重新打开个人操作面板'), '角色', 'GM可选择NPC参战编号', false));
  for (const [name, description] of [['暂停', '暂停装备调整和主动行动'], ['恢复', '恢复当前行动和自动轮换'],
    ['代结束', 'GM结束当前行动机会'], ['结束', '结束战斗并保留剩余生命']]) battle.addSubcommand(s => s.setName(name).setDescription(description));
  battle.addSubcommand(s => str(str(s.setName('添加npc').setDescription('添加NPC模板到战斗'), '模板', 'NPC模板编号'), '阵营', 'NPC阵营', true,
    [{ name: '友方', value: 'ally' }, { name: '敌方', value: 'enemy' }]));
  battle.addSubcommand(s => {
    str(s.setName('位置').setDescription('报名或暂停期间配置参战者位置'), '角色', '参战编号');
    for (const name of ['横坐标', '纵坐标']) s.addNumberOption(o => o.setName(name).setDescription('地图内米数，保留两位小数').setRequired(true).setMinValue(0).setMaxValue(999.99));
    return str(s, '阵营', '可选调整阵营', false, [{ name: '友方', value: 'ally' }, { name: '敌方', value: 'enemy' }]);
  });
  battle.addSubcommand(s => str(int(int(s.setName('地形').setDescription('配置地图某格地形'), '列', '从1开始', true, 1, 20), '行', '从1开始', true, 1, 20), '类型', '地形类型', true,
    [{ name: '普通', value: 'normal' }, { name: '困难', value: 'difficult' }, { name: '阻挡', value: 'blocked' }]));
  battle.addSubcommand(s => int(str(s.setName('生命').setDescription('GM治疗或调整参战者HP'), '角色', '参战编号'), '数值', '新的HP，不超过有效上限', true, 0, 10000000));
  battle.addSubcommand(s => str(str(str(s.setName('异常').setDescription('给参战者施加异常并自动豁免'), '角色', '参战编号'), '模板', '异常模板编号'), '等级', '异常等级', true, C.SEVERITIES));
  battle.addSubcommand(s => str(str(s.setName('解除异常').setDescription('解除某个异常；生命不自动补回'), '角色', '参战编号'), '编号', '异常实例编号'));
  battle.addSubcommand(s => str(s.setName('移出').setDescription('暂停或报名期间移出参战者'), '角色', '参战编号'));
  list.push(battle);
  return list;
}
module.exports = { commands };
