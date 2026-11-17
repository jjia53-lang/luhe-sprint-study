import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {createSync,enqueueCompletion,completionEvent,mergeCloud,mergeRecords,recordBatches,touch,forget,chunkSize,chunkCount,baseRevision,linkToken} from "../cloud-sync.mjs";
import handler from "./handler.cjs";
import http from "./http.cjs";

const student=randomBytes(32).toString("hex");
const parent=randomBytes(32).toString("hex");
const hashed=token=>createHash("sha256").update(token).digest("hex");
const testStudent=randomBytes(32).toString("hex");
const documents=new Map(), recordDocs=new Map(), chunks=new Map();
const receive=handler.createHandler({
  put(id, entry) { documents.set(id, entry); },
  day(date) { return [...documents.values()].filter(entry=>entry.date===date); },
  all() { return [...documents.values()]; },
  records(scope) { return [...recordDocs.values()].filter(row=>row.rscope===scope).map(({rscope,...row})=>row); },
  getRecord(id) { return recordDocs.get(id) ?? null; },
  putRecord(id, record, scope) { recordDocs.set(id, structuredClone({...record,rscope:scope})); },
  putChunk(id, scope, file, index, content) { chunks.set(id, {fscope:scope, content}); },
  getChunk(id, scope) { const chunk=chunks.get(id); return chunk?.fscope===scope ? chunk.content : null; },
},{student:hashed(student),parent:hashed(parent),"test-student":hashed(testStudent)});

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
assert.equal(wordEvent.notes,"本机笔记");
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

// ---- Study records and attachments across two student devices and the parent ----
const studentApi=createSync(receive,student,async()=>({}));
async function syncDevice(state, blobs) {
  const {records}=await studentApi.records();
  let plan=mergeRecords(state,records);
  const uploaded=plan.uploads;
  for (const id of uploaded) {
    const blob=blobs.get(id), total=chunkCount(blob.length);
    for (let index=0;index<total;index++) {
      await studentApi.putChunk(id,index,total,blob.subarray(index*chunkSize,(index+1)*chunkSize).toString("base64"));
    }
    state.attachments.find(file=>file.id===id).uploaded=true;
  }
  plan=mergeRecords(state,records);
  for (const batch of recordBatches(plan.push)) assert.equal((await studentApi.saveRecords(batch)).count,batch.length);
  return {...plan,uploaded};
}
const photo=randomBytes(2*chunkSize+1234);
assert.equal(chunkSize,600000);
const deviceA={tasks:[{id:"daily-2026-11-19-0",date:"2026-11-19",subject:"数学",title:"几何",minutes:30,status:"planned"}],
  logs:[{id:"log-1",date:"2026-11-17",subject:"数学",minutes:30,content:"老日志"}],
  mistakes:[touch({id:"mistake-1",date:"2026-11-17",subject:"数学",title:"面积",cause:"辅助线",correction:"作高",mastered:false})],
  words:[{key:"lend",word:"lend",firstSeen:"2026-11-17",lastSeen:"2026-11-17",attempts:0,note:"借出",known:0}],
  attachments:[{id:"file-1",taskId:"daily-2026-11-17-0",name:"证明.jpg",size:photo.length,type:"image/jpeg",updatedAt:"2026-11-17T08:00:00.000Z",uploaded:false}],
  examDate:"2026-12-31",monthlyDate:null,examConfirmed:false};
Object.assign(deviceA.tasks[0],touch({title:"几何（改为周四）",minutes:40}));
deviceA.examConfirmed=true; deviceA.settingsUpdatedAt=new Date().toISOString();
const first=await syncDevice(deviceA,new Map([["file-1",photo]]));
assert.deepEqual(first.uploaded,["file-1"]);
assert.equal(chunks.size,3);
assert.equal(recordDocs.size,6);

const deviceB={tasks:[{id:"daily-2026-11-19-0",date:"2026-11-19",subject:"数学",title:"几何",minutes:30,status:"planned"}],
  logs:[],mistakes:[],words:[],attachments:[],examDate:"2026-12-31",examConfirmed:false};
await syncDevice(deviceB,new Map());
assert.equal(deviceB.logs[0].content,"老日志");
assert.equal(deviceB.mistakes[0].cause,"辅助线");
assert.equal(deviceB.words[0].note,"借出");
assert.equal(deviceB.tasks[0].title,"几何（改为周四）");
assert.equal(deviceB.tasks[0].status,"planned");
assert.equal(deviceB.examConfirmed,true);
assert.deepEqual(deviceB.attachments[0],{...deviceB.attachments[0],name:"证明.jpg",remote:true,uploaded:true});
const pieces=[];
for (let index=0;index<chunkCount(photo.length);index++) pieces.push(Buffer.from((await studentApi.getChunk("file-1",index)).data,"base64"));
assert.ok(Buffer.concat(pieces).equals(photo));

// Edits and deletions on B reach A; tombstones stop deleted records from coming back.
await new Promise(resolve=>setTimeout(resolve,5));
Object.assign(deviceB.logs[0],touch({content:"在另一台电脑补充"}));
deviceB.mistakes=[];forget(deviceB,"mistake","mistake-1");
deviceB.words[0].known=1;touch(deviceB.words[0]);
await syncDevice(deviceB,new Map());
await syncDevice(deviceA,new Map());
assert.equal(deviceA.logs[0].content,"在另一台电脑补充");
assert.equal(deviceA.mistakes.length,0);
assert.ok(deviceA.removed["mistake:mistake-1"]);
assert.equal(deviceA.words[0].known,1);
assert.notEqual(deviceA.attachments[0].remote,true);
await syncDevice(deviceA,new Map());
assert.equal(deviceA.mistakes.length,0);

// A late, older copy never overwrites a newer edit, and bad records are refused without partial writes.
const stale={type:"log",id:"log-1",rev:"2026-11-16T09:00:00.000Z",deleted:false,data:{content:"过期内容"}};
assert.equal((await studentApi.saveRecords([stale])).count,1);
assert.equal((await studentApi.records()).records.find(row=>row.id==="log-1").data.content,"在另一台电脑补充");
assert.equal((await receive({action:"records.save",token:student,records:[{...stale,id:"bad id"}]})).ok,false);
assert.equal((await receive({action:"records.save",token:student,records:[{...stale,id:"big",data:{content:"长".repeat(20001)}}]})).ok,false);
const huge={logs:[{id:"log-big",content:"长".repeat(20001),updatedAt:new Date().toISOString()}]};
assert.equal(mergeRecords(huge,[]).push.length,0);

// Parent: reads records and attachments, cannot write either.
assert.equal((await receive({action:"records",token:parent})).records.length,6);
assert.equal((await receive({action:"records.save",token:parent,records:[stale]})).ok,false);
assert.equal((await receive({action:"file.put",token:parent,file:"file-2",index:0,total:1,data:"AAAA"})).ok,false);
assert.equal((await receive({action:"file.get",token:parent,file:"file-1",index:0})).ok,true);
assert.equal((await receive({action:"file.put",token:student,file:"file-2",index:2,total:2,data:"AAAA"})).ok,false);
assert.equal((await receive({action:"file.get",token:student,file:"file-1",index:5})).ok,false);
assert.equal((await receive({action:"file.get",token:student,file:"file-1",index:14})).ok,false);
assert.equal((await receive({action:"file.put",token:student,file:"file-2",index:0,total:1,data:"A".repeat(800004)})).ok,false);
assert.equal(recordBatches(Array.from({length:25},(_,i)=>({type:"log",id:"l"+i,rev:baseRevision,deleted:true,data:null}))).map(batch=>batch.length).join(),"10,10,5");

// Parent feedback: only the parent link writes it, students receive it, and old local-only feedback stays put.
const reviewAt=new Date().toISOString();
const review={type:"review",id:"review-1",rev:reviewAt,deleted:false,data:{taskId:"daily-2026-11-17-0",rating:"已确认",comment:"证明过程清楚",author:"假冒",createdAt:reviewAt}};
assert.equal((await receive({action:"records.save",token:parent,records:[review]})).ok,true);
assert.equal((await receive({action:"records.save",token:student,records:[{...review,id:"review-2"}]})).ok,false);
assert.equal((await receive({action:"records.save",token:parent,records:[review,stale]})).ok,false);
assert.equal((await receive({action:"records.save",token:parent,records:[{...review,id:"review-3",data:{...review.data,createdAt:baseRevision}}]})).ok,false);
assert.equal((await receive({action:"records.save",token:parent,records:[{...review,id:"review-4",data:{...review.data,rating:"随便"}}]})).ok,false);
deviceA.reviews=[{id:"local-review",taskId:null,rating:"留言",comment:"本机留言",author:"家长（本机）",createdAt:"2026-11-17T01:00:00.000Z"}];
const withReview=await syncDevice(deviceA,new Map());
assert.equal(withReview.push.some(row=>row.type==="review"),false);
assert.deepEqual(deviceA.reviews.map(item=>[item.id,item.author]).sort(),[["local-review","家长（本机）"],["review-1","家长"]]);
assert.equal((await studentApi.records()).records.filter(row=>row.type==="review").length,1);

// Synthetic test links never see family records or files.
assert.equal((await receive({action:"records",token:testStudent})).records.length,0);
assert.equal((await receive({action:"file.get",token:testStudent,file:"file-1",index:0})).ok,false);

// HTTP wrapper: binary (base64) bodies carry attachment chunks; size is checked after decoding.
const viaHttp=http.httpHandler(receive);
const encoded=body=>({httpMethod:"POST",headers:{origin:"https://jjia53-lang.github.io"},isBase64Encoded:true,body:Buffer.from(body).toString("base64")});
const chunkCall=JSON.stringify({action:"file.put",token:student,file:"file-3",index:0,total:1,data:randomBytes(chunkSize).toString("base64")});
const accepted=await viaHttp(encoded(chunkCall));
assert.equal(accepted.statusCode,200);
assert.equal(accepted.headers["Access-Control-Allow-Origin"],"https://jjia53-lang.github.io");
assert.equal((await viaHttp(encoded(JSON.stringify({action:"connect",token:student,pad:"x".repeat(900000)})))).statusCode,400);
assert.equal((await viaHttp({httpMethod:"POST",headers:{},body:JSON.stringify({action:"connect",token:parent})})).headers["Access-Control-Allow-Origin"],undefined);

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
console.log("Private roles, day and full history, notes, cross-device merge, offline backfill, study records, deletions, attachments, parent read-only with feedback, test isolation, retry-safe writes, revision order, local queue, and remembered links passed.");
