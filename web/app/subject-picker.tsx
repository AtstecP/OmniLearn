"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Subject } from "./types";

export default function SubjectPicker({subjects,value,onSelect}:{subjects:Subject[];value:string;onSelect:(id:string)=>void}){
 const [open,setOpen]=useState(false);
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{function closeMenu(e:PointerEvent){if(ref.current&&!ref.current.contains(e.target as HTMLElement))setOpen(false)}document.addEventListener("pointerdown",closeMenu);return()=>document.removeEventListener("pointerdown",closeMenu)},[]);
 const selected=subjects.find(s=>s.id===value);
 return <div ref={ref} className="subject-select-wrap subject-picker"><button type="button" className="subject-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen(x=>!x)}><span className="subject-dot"/><span className="subject-picker-name">{selected?.title||"Select subject"}</span><ChevronDown className="chevron" size={18}/></button>{open&&<div className="subject-picker-menu" role="listbox" aria-label="Learning subjects">{subjects.length?subjects.map(s=><button type="button" role="option" aria-selected={s.id===value} key={s.id} className="subject-picker-option" onClick={()=>{onSelect(s.id);setOpen(false)}}>{s.title}</button>):<span className="subject-picker-empty">No subjects yet</span>}</div>}</div>;
}
