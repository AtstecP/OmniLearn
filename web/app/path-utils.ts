import type { Node } from "./types";

export function seededOrder<T extends {id:string}>(list:T[],seed:number):T[]{const h=(t:string)=>{let x=seed|0;for(let i=0;i<t.length;i++)x=Math.imul(x^t.charCodeAt(i),16777619)>>>0;return x};return [...list].sort((a,b)=>h(a.id)-h(b.id))}
// The learning path as an outline: main steps in order, each followed by its sub-lessons (same order as the map), numbered 1, 1.1, 1.1.1 ...
export function pathOutline(list:Node[]){let ids=new Set(list.map(n=>n.id)),kids=new Map<string,Node[]>();for(const n of list){let k=n.parent_node_id&&ids.has(n.parent_node_id)&&n.parent_node_id!==n.id?n.parent_node_id:"";if(!kids.has(k))kids.set(k,[]);kids.get(k)!.push(n)}
 let out:{n:Node;num:string;depth:number}[]=[],seen=new Set<string>();const walk=(k:string,prefix:string,depth:number)=>{[...(kids.get(k)||[])].sort((a,b)=>a.order_index-b.order_index||a.id.localeCompare(b.id)).forEach((n,i)=>{if(seen.has(n.id))return;seen.add(n.id);let num=prefix?`${prefix}.${i+1}`:String(i+1);out.push({n,num,depth});walk(n.id,num,depth+1)})};walk("","",0);return out}
