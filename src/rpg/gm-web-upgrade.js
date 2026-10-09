'use strict';
function migrate(s) {
  s.gmWebDevices ||= {};
  if (s.upgrade >= 9) return null;
  s.upgrade = 9;
  return { gmWeb: 9 };
}
module.exports = { migrate };
