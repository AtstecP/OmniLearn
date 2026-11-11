"use client";
import { useState } from "react";
import { api, json } from "@/lib/api";
import type { User } from "./types";

export default function AuthScreen({onAuthenticated}:{onAuthenticated:(user:User)=>void}) {
  const [mode,setMode]=useState<"create"|"login">("create");
  const [email,setEmail]=useState("");
  const [fullName,setFullName]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){
    e.preventDefault();setBusy(true);setError("");
    try {
      const result=await api<{user:User}>(mode==="create"?"/auth/register":"/auth/login",json("POST",mode==="create"?{email,full_name:fullName,password}:{email,password}));
      onAuthenticated(result.user);
    } catch(err:any) { setError(err.message||"Could not sign in."); }
    finally { setBusy(false); }
  }
  return <main className="auth-screen"><form className="auth-card" onSubmit={submit}><img className="brand-logo" src="/logo-mark.png" alt="" width="40" height="32"/><div className="eyebrow">Grab. Generate. Learn.</div><h1>{mode==="create"?"Create your account":"Welcome back"}</h1><p>{mode==="create"?"Create an account to save your subjects and progress securely.":"Sign in to continue learning."}</p>{mode==="create"&&<label className="auth-field"><span>Your name</span><input className="input" required autoComplete="name" value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Alex Morgan"/></label>}<label className="auth-field"><span>Email</span><input className="input" type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label><label className="auth-field"><span>Password</span><input className="input" type="password" required minLength={mode==="create"?12:1} autoComplete={mode==="create"?"new-password":"current-password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==="create"?"At least 12 characters":"Your password"}/>{mode==="create"&&<small>Use at least 12 characters.</small>}</label>{error&&<div className="feedback wrong">{error}</div>}<button className="btn primary auth-submit" disabled={busy}>{busy?"Please wait…":mode==="create"?"Create account":"Sign in"}</button><div className="auth-switch">{mode==="create"?"Already have an account?":"New to Learnify?"} <button type="button" className="text-link" onClick={()=>{setMode(mode==="create"?"login":"create");setError("")}}>{mode==="create"?"Sign in":"Create an account"}</button></div><div className="auth-privacy">Your password is securely hashed. You stay signed in with a secure, private cookie.</div></form></main>;
}
