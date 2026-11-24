"use client";
import { useState } from "react";
import type { Test } from "./types";
import Markdown from "./markdown";

export default function Practice({q,onPractice}:{q:Test;onPractice:(id:string,selected:number)=>Promise<void>}){let [selected,setSelected]=useState<number|undefined>();return <><div className="test-prompt"><Markdown compact text={q.prompt}/></div>{q.options.map((o,i)=><label className="quiz-option" key={i}><input type="radio" name="practice" onChange={()=>setSelected(i)}/><span>{String.fromCharCode(65+i)}.</span> <Markdown compact text={o}/></label>)}<div className="form-actions"><button className="btn primary" disabled={selected===undefined} onClick={()=>selected!==undefined&&onPractice(q.id,selected)}>Check answer</button></div></>}
