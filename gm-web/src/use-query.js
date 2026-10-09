import {useEffect,useRef} from 'react';
export function useQuery(load,deps,receive,error){
  const callbacks=useRef({load,receive,error});callbacks.current={load,receive,error};
  useEffect(()=>{let alive=true;const scope=window.gmSession?.guildId;
    Promise.resolve().then(()=>callbacks.current.load()).then(value=>{if(alive&&scope===window.gmSession?.guildId)callbacks.current.receive(value);}).catch(e=>{if(alive&&scope===window.gmSession?.guildId)callbacks.current.error?.(e.message);});
    return()=>{alive=false;};
  },deps);
}
