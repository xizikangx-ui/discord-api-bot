import {notificationTarget} from './notification-target.js';
export function taskCounts(tasks, gm=false) {
  const counts={};
  for(const task of tasks){const tab=task.tab||notificationTarget(task.system,gm)?.tab;if(tab)counts[tab]=(counts[tab]||0)+1;}
  return counts;
}
export function contextPosition(x,y,width,height) {
  return {left:Math.max(8,Math.min(x,width-238)),top:Math.max(8,Math.min(y,height-470))};
}
