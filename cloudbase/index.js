const cloudbase = require("@cloudbase/node-sdk");
const { createHandler } = require("./handler.cjs");
const { httpHandler } = require("./http.cjs");
const app = cloudbase.init({});
const collection = app.database().collection("sprint_completion");
const store = {
  put(id, value, scope) {
    return collection.doc(id).set({...value,scope});
  },
  async day(date,scope) {
    const entries = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const { data } = await collection.where({date,scope}).orderBy("_id","asc").skip(offset).limit(pageSize).get();
      entries.push(...data.map(({_id,_openid,scope,...entry}) => entry));
      if (data.length < pageSize) return entries;
    }
  },
};
exports.main = httpHandler(createHandler(store, {
  student:process.env.SPRINT_STUDENT_SHA256,
  parent:process.env.SPRINT_PARENT_SHA256,
  "test-student":process.env.SPRINT_TEST_STUDENT_SHA256,
  "test-parent":process.env.SPRINT_TEST_PARENT_SHA256,
}));
