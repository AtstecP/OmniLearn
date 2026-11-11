"use client";
import { useEffect, useState } from "react";
import { api, json } from "@/lib/api";

export function DeleteSubjectCard({title,onExport,onDelete}:{title:string;onExport:()=>void;onDelete:(confirmation:string)=>Promise<void>}){
 const [typed,setTyped]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{setTyped("");setError("")},[title]);
 return <section className="settings-card panel danger-zone subject-danger"><h2>Delete this subject</h2><p>Permanently deletes <strong>{title}</strong> with all its lessons, questions, vocabulary, readings and your progress in it. This cannot be undone, so export a copy first if you might want it back.</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError("");try{await onDelete(typed)}catch(err:any){setError(err.message)}finally{setBusy(false)}}}><div className="form-field"><label htmlFor="deleteSubjectConfirm">Type the subject title to confirm</label><input id="deleteSubjectConfirm" className="input" value={typed} onChange={e=>setTyped(e.target.value)} placeholder={title} autoComplete="off"/></div>{error&&<div className="feedback wrong">{error}</div>}<div className="form-actions"><button type="button" className="btn" onClick={onExport}>Export a copy</button><button type="submit" className="btn danger-button" disabled={busy||typed.trim()!==title.trim()}>{busy?"Deleting…":"Delete subject"}</button></div></form></section>;
}

export function AccountSettings({onDeleted}:{onDeleted:()=>void}) {
  const [currentPassword,setCurrentPassword]=useState("");
  const [newPassword,setNewPassword]=useState("");
  const [deletePassword,setDeletePassword]=useState("");
  const [confirmation,setConfirmation]=useState("");
  const [feedback,setFeedback]=useState("");
  const [busy,setBusy]=useState(false);
  async function changePassword(e:React.FormEvent){
    e.preventDefault();setBusy(true);setFeedback("");
    try{await api("/auth/change-password",json("POST",{current_password:currentPassword,new_password:newPassword}));setCurrentPassword("");setNewPassword("");setFeedback("Password changed successfully.")}
    catch(err:any){setFeedback(err.message||"Could not change password.")}
    finally{setBusy(false)}
  }
  async function resetAccount(e:React.FormEvent){
    e.preventDefault();setBusy(true);setFeedback("");
    try{await api("/auth/account",json("DELETE",{current_password:deletePassword,confirmation}));onDeleted()}
    catch(err:any){setFeedback(err.message||"Could not reset the account.");setBusy(false)}
  }
  return <div className="settings-grid"><section className="panel settings-card"><h2>Change password</h2><p>Choose a new password with at least 12 characters.</p><form onSubmit={changePassword}><label className="auth-field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label><label className="auth-field"><span>New password</span><input className="input" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><button className="btn primary" disabled={busy}>Save new password</button></form></section><section className="panel settings-card danger-zone"><h2>Reset account</h2><p>This permanently deletes your account, subjects, lessons, questions, vocabulary, reading materials, and learning progress.</p><form onSubmit={resetAccount}><label className="auth-field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" required value={deletePassword} onChange={e=>setDeletePassword(e.target.value)}/></label><label className="auth-field"><span>Type DELETE to confirm</span><input className="input" required value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label><button className="btn danger-button" disabled={busy||confirmation!=="DELETE"}>Delete all account data</button></form></section>{feedback&&<div className="settings-feedback" role="status">{feedback}</div>}</div>;
}
