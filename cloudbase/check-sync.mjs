import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {createSync,enqueueCompletion,completionEvent,mergeCloud,linkToken} from "../cloud-sync.mjs";
import handler from "./handler.cjs";

const student=randomBytes(32).toString("hex");
const parent=randomBytes(32).toString("hex");
const hashed=token=>createHash("sha256").update(token).digest("hex");
const documents=new Map();
const receive=handler.createHandler({
  put(id, entry) { documents.set(id, entry); },
  day(date) { return [...documents.values()].filter(entry=>entry.date===date); },
  all() { return [...documents.values()]; },
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
assert.equal(taskEvent.notes,"本机笔记");
assert.equal(wordEvent.notes,undefined);
assert.deepEqual((await viewer.day(task.date)).entries,[taskEvent,wordEvent]);
assert.deepEqual((await viewer.day("2026-11-17")).entries,[]);
assert.equal((await receive({action:"day",token:parent,date:"2026-11-31"})).ok,false);
assert.equal((await receive({action:"save",token:student,entries:[{...taskEvent,minutes:1000}]})).ok,false);
assert.equal((await receive({action:"save",token:student,entries:[{...taskEvent,notes:"长".repeat(1001)}]})).ok,false);
assert.equal((await receive({action:"save",token:student,entries:[{...wordEvent,extra:"无关字段"}]})).ok,true);
assert.equal(documents.size,2);
const correction={...taskEvent,minutes:45,revision:"2026-11-16T11:00:00.000Z"};
enqueueCompletion(sent,correction);
await uploader.flush();
await receive({action:"save",token:student,entries:[taskEvent]});
assert.equal((await viewer.day(task.date)).entries.find(row=>row.kind==="task").minutes,45);

// A second browser for the same student: completions appear there, local-only records stay put.
const other={tasks:[{id:task.id,date:task.date,title:task.title,subject:task.subject,minutes:35,status:"planned"}],
  vocabulary:[],logs:[{id:"log",content:"只在本机"}],syncPending:[]};
assert.equal(mergeCloud(other,(await viewer.all()).entries),2);
assert.deepEqual(other.tasks[0],{...other.tasks[0],status:"submitted",actualMinutes:45,submittedAt:correction.revision,notes:"本机笔记"});
assert.equal(other.vocabulary[0].minutes,40);
assert.equal(other.logs.length,1);
assert.equal(other.syncPending.length,0);
assert.equal(mergeCloud(other,(await viewer.all()).entries),0);

// Unknown tasks are created, and completions made without the family link are queued for upload.
const custom={kind:"task",itemId:"8c1f0a9e-1111-4222-8333-944455556666",date:"2026-11-17",title:"自选阅读",subject:"英语",
  minutes:20,revision:"2026-11-17T09:00:00.000Z"};
const offline={tasks:[{id:"daily-2026-11-18-0",date:"2026-11-18",title:"函数复习",subject:"数学",minutes:30,
  status:"submitted",actualMinutes:30,submittedAt:"2026-11-18T09:00:00.000Z",notes:"离线完成"},
  {id:"old",date:"2026-11-10",title:"冲刺前",subject:"数学",status:"submitted",actualMinutes:30,submittedAt:"2026-11-10T09:00:00.000Z"}],
  vocabulary:[{date:"2026-11-18",minutes:40,completedAt:"2026-11-18T10:00:00.000Z"}]};
mergeCloud(offline,[custom]);
assert.equal(offline.tasks.find(item=>item.id===custom.itemId).status,"submitted");
assert.deepEqual(offline.syncPending.map(row=>row.itemId),["daily-2026-11-18-0","words"]);
const offlineState=async change=>{change?.(offline);return structuredClone(offline);};
await createSync(receive,student,offlineState).flush();
const fresh={tasks:[],vocabulary:[]};
mergeCloud(fresh,(await viewer.all()).entries);
assert.equal(fresh.tasks.find(item=>item.id==="daily-2026-11-18-0").notes,"离线完成");
assert.equal(fresh.tasks.some(item=>item.id==="old"),false);
assert.equal((await receive({action:"all",token:"0".repeat(64)})).ok,false);

const browserStorage=new Map();
const storage={setItem:(key,value)=>browserStorage.set(key,value),getItem:key=>browserStorage.get(key),removeItem:key=>browserStorage.delete(key)};
const loc={pathname:"/luhe-sprint-study/",search:"",hash:"#sync="+parent};
let clean;
assert.equal(linkToken(loc,{replaceState:(_,__,path)=>{clean=path;}},storage),parent);
assert.equal(clean,loc.pathname);
assert.equal(linkToken({...loc,hash:""},{replaceState(){}},storage),parent);
const remembered=new Map(), tabOnly=new Map([["sprint-sync-token",student]]);
const wrap=map=>({setItem:(key,value)=>map.set(key,value),getItem:key=>map.get(key),removeItem:key=>map.delete(key)});
assert.equal(linkToken({...loc,hash:""},{replaceState(){}},wrap(remembered),wrap(tabOnly)),student);
assert.equal(remembered.get("sprint-sync-token"),student);
assert.equal(tabOnly.size,0);
console.log("Private roles, day and full history, notes, cross-device merge, offline backfill, retry-safe writes, revision order, local queue, and remembered links passed.");
