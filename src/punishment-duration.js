const MINUTES_PER_DAY = 1440;
const MAX_MINUTES = 90 * MINUTES_PER_DAY;

function addPunishmentDurationOptions(command) {
  return command
    .addIntegerOption(o => o.setName('禁言天数').setDescription('禁言时长1–90天；与禁言分钟二选一').setMinValue(1).setMaxValue(90))
    .addIntegerOption(o => o.setName('警告天数').setDescription('警告保留1–90天；与警告分钟二选一；留空不自动移除').setMinValue(1).setMaxValue(90))
    .addIntegerOption(o => o.setName('禁言分钟').setDescription('禁言时长1–129600分钟；与禁言天数二选一').setMinValue(1).setMaxValue(MAX_MINUTES))
    .addIntegerOption(o => o.setName('警告分钟').setDescription('警告保留1–129600分钟；与警告天数二选一；留空不自动移除').setMinValue(1).setMaxValue(MAX_MINUTES));
}
function readPunishmentDurations(options) {
  const read = (label) => {
    const days = options.getInteger(`${label}天数`);
    const minutes = options.getInteger(`${label}分钟`);
    if (days != null && minutes != null) throw new Error(`${label}天数和${label}分钟只能填写一项。`);
    if (days != null && (!Number.isInteger(days) || days < 1 || days > 90)) throw new Error(`${label}天数必须为1–90的整数。`);
    if (minutes != null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)) throw new Error(`${label}分钟必须为1–${MAX_MINUTES}的整数。`);
    // Keep the persisted day-based schema readable by old cases, schedules and polls.
    return minutes != null ? minutes / MINUTES_PER_DAY : days ?? null;
  };
  return { timeoutDays: read('禁言'), warningDays: read('警告') };
}
function validatePunishmentDurations(request) {
  if (!['warning', 'timeout', 'both', 'ban'].includes(request.mode)) throw new Error('处罚方式无效。');
  for (const [key, label] of [['timeoutDays', '禁言'], ['warningDays', '警告']]) {
    const days = request[key];
    if (days == null) continue;
    const minutes = days * MINUTES_PER_DAY;
    if (!Number.isFinite(minutes) || minutes < 1 - 1e-8 || minutes > MAX_MINUTES
      || Math.abs(minutes - Math.round(minutes)) > 1e-8) throw new Error(`${label}时长须为1分钟至90天的整分钟。`);
  }
  if (['timeout', 'both'].includes(request.mode) && !request.timeoutDays) throw new Error('此处罚方式需要填写禁言分钟或禁言天数。');
  if (!['timeout', 'both'].includes(request.mode) && request.timeoutDays != null) throw new Error('此方式不能填写禁言时长。');
  if (!['warning', 'both'].includes(request.mode) && request.warningDays != null) throw new Error('此方式不能填写警告时长。');
}
function formatPunishmentDuration(days) {
  const minutes = Math.round(days * MINUTES_PER_DAY);
  return minutes % MINUTES_PER_DAY === 0 ? `${minutes / MINUTES_PER_DAY} 天` : `${minutes} 分钟`;
}
function parsePunishmentDurationText(text) {
  const match = String(text || '').match(/^(\d+) (天|分钟)$/);
  return match ? Number(match[1]) / (match[2] === '分钟' ? MINUTES_PER_DAY : 1) : null;
}
module.exports = { addPunishmentDurationOptions, readPunishmentDurations, validatePunishmentDurations,
  formatPunishmentDuration, parsePunishmentDurationText, MAX_MINUTES };
