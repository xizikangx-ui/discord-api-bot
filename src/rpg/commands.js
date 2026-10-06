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
const item = (s, name = '物品', required = true) => s.addStringOption(o => o.setName(name).setDescription('搜索物品名称；留空打开分页下拉面板').setRequired(required).setAutocomplete(true));
function commands() {
  const list = [
    cmd('跑团配置面板', '配置GM、玩家、公告和领取身份组面板').setDefaultMemberPermissions(P.ManageGuild),
    str(str(cmd('rd', '掷骰，默认1d100'), '骰式', '如r2d20、1d100或1d10+2', false), '模式', '普通、优势或劣势', false,
      [{ name: '普通', value: 'normal' }, { name: '优势', value: 'advantage' }, { name: '劣势', value: 'disadvantage' }]),
    str(cmd('建卡', '生成或继续待确认角色卡'), '名字', '角色名', false),
    user(cmd('角色卡', '公开查看角色属性、等级和生命'), false),
    cmd('角色设置', '个人角色面板：性别、背景、外貌、信念与自由点分配'),
    ...['角色图片','npc图片'].map(name => cmd(name, name==='角色图片'?'预览并上传或清除自己的角色头像和立绘':'GM选择NPC更新头像及立绘')
      .addAttachmentOption(o=>o.setName('头像').setDescription('右上头像，PNG/JPEG/WebP，最多4 MiB'))
      .addAttachmentOption(o=>o.setName('立绘').setDescription('底部大图，PNG/JPEG/WebP，最多4 MiB'))
      .addStringOption(o=>o.setName('清除').setDescription('清除位置；不能与上传同时使用').addChoices({name:'头像',value:'avatar'},{name:'立绘',value:'illustration'},{name:'两者',value:'both'}))),
    int(str(cmd('分配属性点', '为自己的角色分配自由属性点'), '属性', '选择属性', true,
      Object.entries(C.ATTRIBUTES).map(([value, name]) => ({ name, value }))), '点数', '增加的点数', false, 1, 100000),
    cmd('抽卡', '消耗一次抽卡次数；超重时保留待领取结果'),
    str(cmd('开箱', '消耗一次对应箱型次数，整批领取1至6件随机物品'), '箱型', '要开启的箱子', true, C.BOXES),
    cmd('地图配置', 'GM录入地图大类、房间、保险箱概率与钥匙次数'),
    cmd('地图', '创建、管理或参与带迷雾的探索地图'),
    cmd('势力', '查看世界背景、势力介绍并选择角色归属'),
    user(cmd('背包', '私密查看自己的资产；GM可查看他人'), false),
    item(cmd('使用', '使用自己的食物、药品或消耗品'), '物品', false),
    cmd('开团', 'GM创建跑团报名及定时提及，管理已有开团'),
    int(item(cmd('丢弃', '确认后丢弃自己的未装备物品'), '物品', false), '数量', '丢弃数量', false, 1, 100000),
    item(item(str(cmd('装备', '下拉选择装备、配件及槽位操作'), '操作', '操作类型', false,
      ['装备', '卸下', '装配', '拆下', '使用道具', '使用世界树之心-头部', '使用世界树之心-身体', '使用世界树之心-戒指', '使用世界树之泪']), '物品', false), '配件', false),
    user(cmd('交易', '与另一位玩家交换物品及游戏币')),
    int(user(cmd('转账', '向另一位玩家转账，发送方确认后到账')), '金额', '转账金额', true, 1, C.MAX_MONEY),
    str(cmd('录入物品', 'GM分步录入物品、装备、卡牌或技能'), '类型', '模板种类', false, C.ITEM_KINDS),
    cmd('录入词条', 'GM录入结构化词条或展示文字'),
    cmd('录入异常', 'GM录入异常、各级效果与恶化规则'),
    str(cmd('规则', '跑团规则、公式及示例'), '章节', '速查章节', false, ['总览', '世界背景', '势力', '建卡', '升级', '负重', '装备', '交易', '抽取', '食物药品', '鉴定', '开团', '地图', '击杀与死亡', '保险箱', '战斗', '异常', '指令', '角色设置', '时运', '物价']),
  ];
  const check = cmd('鉴定', 'GM发布或管理玩家鉴定');
  check.addSubcommand(s => {
    str(str(s.setName('发布').setDescription('发布公开鉴定要求'), '名称', '鉴定名称'), '规则', '判定规则', true,
      [{ name: 'd20加属性达到难度', value: 'd20' }, { name: 'd100不超过判定值', value: 'd100' }]);
    int(s, '门槛', 'd20难度或d100判定值，d100最多100', true, 1, 1000000);
    str(s, '说明', '任务要求', false);
    str(s, '属性', '仅d20有效，默认无属性加成', false, [{ name: '无', value: 'none' }, ...Object.entries(C.ATTRIBUTES).map(([value, name]) => ({ value, name }))]);
    return int(s, '次数', '每人最多尝试次数，默认1', false, 1, 10);
  });
  check.addSubcommand(s => s.setName('管理').setDescription('GM查看、结束或重新公示鉴定'));
  list.push(check);
  const gm = cmd('gm', 'GM发放、收购、销卡、模板和NPC管理');
  gm.addSubcommand(s => int(user(s.setName('经验').setDescription('发放经验，自动应用适应性与升级')), '数量', '基础经验', true, 1, 1000000000));
  gm.addSubcommand(s => int(user(s.setName('属性点').setDescription('额外发放自由属性点')), '数量', '点数', true, 1, 100000));
  gm.addSubcommand(s => int(item(user(s.setName('发放').setDescription('单人快捷发放；不填成员打开批量面板'), false), '物品', false), '数量', '发放数量', false, 1, 100));
  gm.addSubcommand(s => int(item(user(s.setName('批量发放').setDescription('多选玩家和物品，分别设置每人数量并确认'), false), '物品', false), '数量', '预选物品的每人数量', false, 1, 100));
  gm.addSubcommand(s => int(str(user(s.setName('次数').setDescription('发放抽卡或指定箱型次数')), '类型', '抽卡或箱型', true, ['抽卡', ...C.BOXES]), '数量', '发放次数', true, 1, 100000));
  gm.addSubcommand(s => int(int(item(user(s.setName('收购').setDescription('GM私有选物报价面板，或填写完整参数快捷收购')), '物品', false), '价格', '快捷收购总价，面板中可填写', false, 0, C.MAX_MONEY), '数量', '收购数量', false, 1, 100000));
  gm.addSubcommand(s => user(s.setName('销卡').setDescription('确认后清空角色与财产，保留审计')));
  gm.addSubcommand(s => int(user(s.setName('时运').setDescription('设置玩家基础时运，不能使用自由点')), '数值', '基础时运（-9至11）', true, -9, 11));
  gm.addSubcommand(s => s.setName('npc').setDescription('创建或继续NPC模板草稿'));
  gm.addSubcommand(s => s.setName('草稿').setDescription('下拉选择自己的持久录入草稿'));
  gm.addSubcommand(s => item(s.setName('修改模板').setDescription('选择模板发布新版本；已发放实例不变'), '物品', false));
  gm.addSubcommand(s => str(s.setName('模板库').setDescription('查看物品、词条、异常和NPC模板'), '类型', '模板分类', false, ['物品', '词条', '异常', 'NPC']));
  gm.addSubcommand(s => s.setName('恢复存档').setDescription('重新读取加密存档，核对不明确写入结果'));
  gm.addSubcommand(s => s.setName('文本编辑').setDescription('下拉编辑背景、势力、部门与规则正文'));
  gm.addSubcommand(s => s.setName('抽取公示').setDescription('查看与补发已存抽取结果，不重新抽取'));
  list.push(gm);
  const battle = cmd('战斗', 'GM招募、战斗操作与玩家个人面板');
  battle.addSubcommand(s => str(int(int(str(s.setName('招募').setDescription('在当前频道发布战斗招募'), '名称', '战斗名称'),
    '列数', '地图列数，默认10', false, 1, 20), '行数', '地图行数，默认10', false, 1, 20), '场景', '场景说明', false));
  battle.addSubcommand(s => str(s.setName('开战').setDescription('锁定阵容并自动轮换行动'), '偷袭', 'GM确认偷袭阵营', false,
    [{ name: '友方', value: 'ally' }, { name: '敌方', value: 'enemy' }]));
  battle.addSubcommand(s => s.setName('面板').setDescription('查看战场或重新打开个人操作面板'));
  for (const [name, description] of [['暂停', '暂停装备调整和主动行动'], ['恢复', '恢复当前行动和自动轮换'],
    ['代结束', 'GM结束当前行动机会'], ['结束', '结束战斗并保留剩余生命']]) battle.addSubcommand(s => s.setName(name).setDescription(description));
  battle.addSubcommand(s => s.setName('添加npc').setDescription('下拉选择NPC模板和阵营'));
  battle.addSubcommand(s => s.setName('位置').setDescription('下拉选择参战者调整位置'));
  battle.addSubcommand(s => str(int(int(s.setName('地形').setDescription('配置地图某格地形'), '列', '从1开始', true, 1, 20), '行', '从1开始', true, 1, 20), '类型', '地形类型', true,
    [{ name: '普通', value: 'normal' }, { name: '困难', value: 'difficult' }, { name: '阻挡', value: 'blocked' }]));
  battle.addSubcommand(s => s.setName('生命').setDescription('下拉选择参战者调整生命'));
  battle.addSubcommand(s => s.setName('异常').setDescription('下拉选择角色和异常模板'));
  battle.addSubcommand(s => s.setName('解除异常').setDescription('下拉选择角色与待解除异常'));
  battle.addSubcommand(s => s.setName('移出').setDescription('下拉选择要移出的参战者'));
  list.push(battle);
  return list;
}
module.exports = { commands };
