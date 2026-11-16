const cloudbase = require("@cloudbase/node-sdk");
const { createHandler } = require("./handler.cjs");
const app = cloudbase.init({});
const collection = app.database().collection("sprint_completion");
const store = {
  put(id, value) {
    return collection.doc(id).set(value);
  },
  async day(date) {
    const entries = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const { data } = await collection.where({date}).orderBy("_id","asc").skip(offset).limit(pageSize).get();
      entries.push(...data);
      if (data.length < pageSize) return entries;
    }
  },
};
exports.main = createHandler(store, {
  student:process.env.SPRINT_STUDENT_SHA256,
  parent:process.env.SPRINT_PARENT_SHA256,
});
