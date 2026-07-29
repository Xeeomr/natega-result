/* =========================================================================
   netlify/functions/search.js
   دالة خلفية (Serverless Function) للبحث في بيانات الطلاب.

   الفكرة الأساسية: البيانات مقسّمة إلى ملفات صغيرة (Shards)، وكل جزء يغطي
   نطاقًا متصلًا من أرقام الجلوس (لأنها مرتبة تصاعديًا وقت البناء). هذا يتيح:

   - البحث برقم الجلوس: نحدّد الجزء الصحيح فقط (عبر النطاق المخزَّن في
     manifest.json) ونحمّله هو فقط، فيكون البحث سريعًا جدًا حتى عند أول
     تشغيل بارد (Cold Start) — لا داعي لتحميل باقي الأجزاء إطلاقًا.
   - البحث بالاسم: يحتاج فحص كل السجلات (الاسم قد يكون في أي جزء)، فنحمّل كل
     الأجزاء عند أول طلب بحث بالاسم فقط، وتبقى محفوظة بالذاكرة بعدها.
   - إحصائيات لوحة التحقق (meta): محسوبة بالكامل وقت البناء (build_data.py)
     ومخزَّنة جاهزة في manifest.json، فلا حاجة لتحميل أي جزء لعرضها إطلاقًا.

   المتصفح لا يُنزّل أبدًا ملف البيانات الكامل؛ فقط يرسل طلب بحث صغيرًا ويستقبل
   نتيجة صغيرة الحجم فورًا.
   ========================================================================= */

"use strict";

const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
const manifest = require(path.join(DATA_DIR, "manifest.json"));

const MAX_NAME_MATCHES = 500;
const EMPTY_EXTRA = Object.freeze({});

const { statusDict, extras, shardRanges, stats } = manifest;

// -------------------------------------------------------------------
// تطبيع النص العربي — يُستخدم فقط لعبارة البحث نفسها عند الطلب (أسماء
// الطلاب نفسها مطبَّعة سلفًا وقت البناء داخل ملفات الأجزاء، فلا تتكرر هذه
// العملية 919 ألف مرة عند كل Cold Start)
// -------------------------------------------------------------------
function normalizeArabic(input) {
  if (input === null || input === undefined) return "";
  let s = String(input);
  s = s.replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED\u0670]/g, "");
  s = s.replace(/\u0640/g, "");
  s = s.replace(/[\u0623\u0625\u0622]/g, "\u0627");
  s = s.replace(/\u0649/g, "\u064A");
  s = s.replace(/\u0629/g, "\u0647");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function normalizeSeatingNo(input) {
  if (input === null || input === undefined) return "";
  return String(input).trim();
}

// -------------------------------------------------------------------
// تحويل سجل خام [seatingNo, name, normalizedName, totalDegree, statusCode]
// إلى كائن طالب كامل
// -------------------------------------------------------------------
function toStudent(rec) {
  const seatingNo = rec[0];
  const totalDegree = rec[3];
  const extraEntry = extras[seatingNo];

  return {
    seatingNo,
    name: rec[1],
    normalizedName: rec[2],
    totalDegree: totalDegree === undefined ? null : totalDegree,
    maxTotal: extraEntry && extraEntry.maxTotal !== undefined ? extraEntry.maxTotal : null,
    status: statusDict[rec[4]] || "",
    extra: extraEntry && extraEntry.extra ? extraEntry.extra : EMPTY_EXTRA,
  };
}

// -------------------------------------------------------------------
// تحميل جزء واحد (Shard) وفهرسته، مع تخزين مؤقت لكل جزء على حدة حتى لا
// يُعاد تحميله مرة أخرى في نفس نسخة التشغيل (Warm Invocation)
// -------------------------------------------------------------------
const shardCache = new Map(); // shardIndex -> { students: [...], byId: Map }

function loadShard(shardIndex) {
  if (shardCache.has(shardIndex)) return shardCache.get(shardIndex);

  const shardMeta = shardRanges[shardIndex];
  const shardPath = path.join(DATA_DIR, shardMeta.file);
  const records = JSON.parse(fs.readFileSync(shardPath, "utf8"));

  const students = new Array(records.length);
  const byId = new Map();

  for (let i = 0; i < records.length; i++) {
    const student = toStudent(records[i]);
    students[i] = student;

    if (student.seatingNo) {
      const existing = byId.get(student.seatingNo);
      if (!existing) {
        byId.set(student.seatingNo, student);
      } else {
        if (!existing.__duplicates) existing.__duplicates = [existing];
        existing.__duplicates.push(student);
      }
    }
  }

  const entry = { students, byId };
  shardCache.set(shardIndex, entry);
  return entry;
}

function findShardIndexForSeating(seatingNo) {
  // مقارنة رقمية إن أمكن (نفس طول الأرقام عادة)، وإلا نصية كحل احتياطي
  const asNum = Number(seatingNo);
  const useNumeric = !isNaN(asNum) && seatingNo !== "";

  for (let i = 0; i < shardRanges.length; i++) {
    const r = shardRanges[i];
    if (useNumeric) {
      const min = Number(r.minSeat);
      const max = Number(r.maxSeat);
      if (!isNaN(min) && !isNaN(max) && asNum >= min && asNum <= max) return i;
    } else {
      if (seatingNo >= r.minSeat && seatingNo <= r.maxSeat) return i;
    }
  }
  return -1;
}

let allShardsLoadedCache = null; // مصفوفة كل الطلاب — تُبنى فقط عند أول بحث بالاسم

function loadAllShards() {
  if (allShardsLoadedCache) return allShardsLoadedCache;

  let total = 0;
  const perShard = new Array(shardRanges.length);
  for (let i = 0; i < shardRanges.length; i++) {
    const { students } = loadShard(i);
    perShard[i] = students;
    total += students.length;
  }

  const all = new Array(total);
  let idx = 0;
  for (let i = 0; i < perShard.length; i++) {
    const arr = perShard[i];
    for (let j = 0; j < arr.length; j++) all[idx++] = arr[j];
  }

  allShardsLoadedCache = all;
  return all;
}

// -------------------------------------------------------------------
// البحث
// -------------------------------------------------------------------
function searchBySeatingNo(query) {
  const cleaned = normalizeSeatingNo(query);
  if (!cleaned) return null;

  const shardIndex = findShardIndexForSeating(cleaned);
  if (shardIndex === -1) return null;

  const { byId } = loadShard(shardIndex);
  return byId.get(cleaned) || null;
}

function searchByName(query, limit) {
  const normalizedQuery = normalizeArabic(query);
  if (!normalizedQuery) return [];

  const words = normalizedQuery.split(" ").filter(Boolean);
  const cap = limit || MAX_NAME_MATCHES;
  const allStudents = loadAllShards();

  const exact = [];
  const startsWith = [];
  const contains = [];
  const wordMatch = [];

  for (let i = 0; i < allStudents.length; i++) {
    const s = allStudents[i];
    if (!s.normalizedName) continue;

    if (s.normalizedName === normalizedQuery) {
      exact.push(s);
    } else if (s.normalizedName.startsWith(normalizedQuery)) {
      startsWith.push(s);
    } else if (s.normalizedName.includes(normalizedQuery)) {
      contains.push(s);
    } else if (words.length > 1 && words.every((w) => s.normalizedName.includes(w))) {
      wordMatch.push(s);
    }

    if (exact.length + startsWith.length + contains.length + wordMatch.length >= cap) {
      break;
    }
  }

  return [...exact, ...startsWith, ...contains, ...wordMatch];
}

// لا نُرجع normalizedName أو __duplicates الداخلية للعميل كما هي (نحوّل __duplicates لعدد فقط)
function toPublicStudent(s) {
  if (!s) return null;
  const { normalizedName, __duplicates, ...rest } = s;
  return {
    ...rest,
    duplicateCount: __duplicates ? __duplicates.length : 1,
  };
}

// -------------------------------------------------------------------
// نقطة الدخول
// -------------------------------------------------------------------
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const params = (event && event.queryStringParameters) || {};
    const type = params.type;
    const q = (params.q || "").toString();
    const limitParam = parseInt(params.limit, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), MAX_NAME_MATCHES) : MAX_NAME_MATCHES;

    // إحصائيات لوحة التحقق محسوبة بالكامل مسبقًا وقت البناء — استجابة فورية
    // دون تحميل أي جزء من ملفات البيانات إطلاقًا.
    if (type === "meta") {
      return { statusCode: 200, headers, body: JSON.stringify({ stats }) };
    }

    if (!type || !q.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "MISSING_PARAMS", message: "الرجاء تحديد type و q" }),
      };
    }

    if (type === "seating") {
      const student = searchBySeatingNo(q);
      return { statusCode: 200, headers, body: JSON.stringify({ student: toPublicStudent(student) }) };
    }

    if (type === "name") {
      const results = searchByName(q, limit).map(toPublicStudent);
      return { statusCode: 200, headers, body: JSON.stringify({ results, total: results.length }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "INVALID_TYPE" }) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "SERVER_ERROR" }),
    };
  }
};
