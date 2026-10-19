import React,{createContext,useContext} from 'react';
import {api} from './data';
const Context=createContext(null);
export function GMContextProvider({value,children}){return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useGMContext(){return useContext(Context)||{api,scope:window.gmSession?.guildId||'local',active:true,schema:window.gmSchema,directory:window.gmDirectory,boxes:window.gmBoxes||[],direct:!!window.gmDirect,session:window.gmSession||{},mediaBase:window.gmMediaBase||'/api/gm/v1',names:window.gmNames||={}};}

export function GMActivity({active,children}){const parent=useGMContext();return <Context.Provider value={{...parent,active}}>{children}</Context.Provider>;}
