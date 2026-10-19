import {useGMContext} from './context';
import {useEffect,useRef} from 'react';
export function useQuery(load,deps,receive,error){
  const gm=useGMContext();
  const callbacks=useRef({load,receive,error});callbacks.current={load,receive,error};
  useEffect(()=>{if(!gm.active)return;let alive=true;const current=callbacks.current;
    Promise.resolve().then(()=>current.load()).then(value=>{if(alive)current.receive(value);}).catch(e=>{if(alive)current.error?.(e.message);});
    return()=>{alive=false;};
  },[gm.scope,gm.active,...deps]);
}
