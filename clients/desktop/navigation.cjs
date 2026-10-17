'use strict';
const HOME='https://yichang.up.railway.app/';
function internal(value){try{const u=new URL(value);return u.origin===new URL(HOME).origin&&!u.username&&!u.password;}catch{return false;}}
function external(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}
module.exports={HOME,internal,external};
