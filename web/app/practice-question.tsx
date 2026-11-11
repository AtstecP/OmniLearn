"use client";
import { useState } from "react";
import type { Test } from "./types";

export default function Practice({q,onPractice}:{q:Test;onPractice:(id:string,selected:number)=>Promise<void>}){let [selected,setSelected]=useState<number|undefined>();return <><p className="test-prompt">{q.prompt}</p>{q.options.map((o,i)=><label className="quiz-option" key={i}><input type="radio" name="practice" onChange={()=>setSelected(i)}/>{String.fromCharCode(65+i)}. {o}</label>)}<div className="form-actions"><button className="btn primary" disabled={selected===undefined} onClick={()=>selected!==undefined&&onPractice(q.id,selected)}>Check answer</button></div></>}
