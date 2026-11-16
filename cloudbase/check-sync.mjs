import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {createSync,enqueueCompletion,completionEvent,linkToken} from "../cloud-sync.mjs";
import handler from "./handler.cjs";

const student=randomBytes(32).toString("hex");
const parent=randomBytes(32).toString("hex");
const hashed=token=>createHash("sha256").update(token).digest("hex");
const documents=new Map();
const receive=handler.createHandler({
  put(id, entry) { documents.set(id, entry); },
  day(date) { return [...documents.values()].filter(entry=>entry.date===date); },
},{student:hashed(student),parent:hashed(parent)});

const sent={syncPending:[]};
const withState=async change=>{change?.(sent);return structuredClone(sent);};
let fail=true;
const uploader=createSync(data=>{
  if (fail && data.action==="save") throw Error("simulate connection outage");
  return receive(data);
},student,withState);
const viewer=createSync(receive,parent,async()=>({}));
assert.equal((await uploader.connect()).role,"student");
assert.equal((await viewer.connect()).role,"parent");
assert.equal((await receive({action:"day",date:"2026-11-16"})).ok,false);

const task={id:"daily-2026-11-16-0",date:"2026-11-16",title:"几何证明",subject:"数学",
  submittedAt:"2026-11-16T10:00:00.000Z",actualMinutes:35,notes:"本机笔记"};
const taskEvent=completionEvent("task",task);
const wordEvent=completionEvent("vocab",{date:task.date,minutes:40,completedAt:task.submittedAt,notes:"本机笔记"});
enqueueCompletion(sent,taskEvent);
enqueueCompletion(sent,wordEvent);
await assert.rejects(uploader.flush(),/outage/);
assert.equal(sent.syncPending.length,2);
assert.equal(documents.size,0);
assert.equal((await receive({action:"save",token:parent,entries:[taskEvent]})).ok,false);

fail=false;
await uploader.flush();
assert.equal(sent.syncPending.length,0);
assert.deepEqual((await viewer.day(task.date)).entries,[taskEvent,wordEvent]);
assert.deepEqual((await viewer.day("2026-11-17")).entries,[]);
assert.equal((await receive({action:"day",token:parent,date:"2026-11-31"})).ok,false);
assert.equal((await receive({action:"save",token:student,entries:[{...taskEvent,minutes:1000}]})).ok,false);
await receive({action:"save",token:student,entries:[{...taskEvent,notes:"无关字段"}]});
assert.equal(documents.size,2);
const correction={...taskEvent,minutes:45,revision:"2026-11-16T11:00:00.000Z"};
enqueueCompletion(sent,correction);
await uploader.flush();
await receive({action:"save",token:student,entries:[taskEvent]});
assert.equal((await viewer.day(task.date)).entries.find(row=>row.kind==="task").minutes,45);

const browserStorage=new Map();
const storage={setItem:(key,value)=>browserStorage.set(key,value),getItem:key=>browserStorage.get(key),removeItem:key=>browserStorage.delete(key)};
const loc={pathname:"/luhe-sprint-study/",search:"",hash:"#sync="+parent};
let clean;
assert.equal(linkToken(loc,{replaceState:(_,__,path)=>{clean=path;}},storage),parent);
assert.equal(clean,loc.pathname);
console.log("Private roles, day history, retry-safe writes, revision order, local queue, and fragment handling passed.");
