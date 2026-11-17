const cloudbase = require("@cloudbase/node-sdk");
const { createHandler } = require("./handler.cjs");
const { httpHandler } = require("./http.cjs");
const app = cloudbase.init({});
const collection = app.database().collection("sprint_completion");
// One private collection holds three kinds of documents, told apart by their scope field:
// completions use "scope", study records "rscope", and attachment chunks "fscope".
async function query(filter) {
  const entries = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { data } = await collection.where(filter).orderBy("_id","asc").skip(offset).limit(pageSize).get();
    entries.push(...data.map(({_id,_openid,scope,rscope,...entry}) => entry));
    if (data.length < pageSize) return entries;
  }
}
async function find(id) {
  const { data } = await collection.doc(id).get();
  return data?.[0] ?? null;
}
const store = {
  put(id, value, scope) {
    return collection.doc(id).set({...value,scope});
  },
  day(date,scope) { return query({date,scope}); },
  all(scope) { return query({scope}); },
  records(scope) { return query({rscope:scope}); },
  getRecord:find,
  putRecord(id, record, scope) { return collection.doc(id).set({...record,rscope:scope}); },
  async putChunk(id, scope, file, index, content) {
    const { fileID } = await app.uploadFile({ cloudPath:`sprint-files/${scope}/${file}/${index}`, fileContent:content });
    await collection.doc(id).set({ fscope:scope, file, index, fileID });
  },
  async getChunk(id, scope) {
    const chunk = await find(id);
    if (!chunk || chunk.fscope !== scope) return null;
    const { fileContent } = await app.downloadFile({ fileID:chunk.fileID });
    return fileContent;
  },
};
exports.main = httpHandler(createHandler(store, {
  student:process.env.SPRINT_STUDENT_SHA256,
  parent:process.env.SPRINT_PARENT_SHA256,
  "test-student":process.env.SPRINT_TEST_STUDENT_SHA256,
  "test-parent":process.env.SPRINT_TEST_PARENT_SHA256,
}));
