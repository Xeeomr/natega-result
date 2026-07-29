/* =========================================================================
   تطبيق نتيجة الثانوية العامة
   - الصفحة تفتح فورًا (لا يوجد أي تحميل لبيانات ضخمة في المتصفح).
   - كل بحث (رقم جلوس أو اسم) يُرسل كطلب صغير إلى دالة خلفية على الخادم
     (Netlify Function)، والتي تحتفظ ببيانات الطلاب بالكامل في الذاكرة وتُعيد
     فقط النتيجة المطلوبة. هذا ما يجعل فتح الصفحة فوريًا كأي موقع عادي.
   ========================================================================= */

(() => {
  "use strict";

  // -------------------------------------------------------------------
  // إعدادات عامة
  // -------------------------------------------------------------------
  const API_ENDPOINT = "/.netlify/functions/search";
  const RESULTS_PER_PAGE = 20;
  const MAX_SUGGESTIONS = 6;

  // المجموع الكلي الرسمي لطلاب الثانوية العامة بالنظام الحديث 2026 (وزارة التربية
  // والتعليم: 320 درجة لكل الشعب)، يُستخدم فقط كقيمة احتياطية عند عدم وجود عمود
  // "نهاية عظمى" صريح داخل ملف البيانات نفسه.
  const DEFAULT_MAX_TOTAL = 320;

  const state = {
    currentMode: "seating",
    currentNameResults: [],
    currentPage: 1,
    currentStudentPercentage: null,
    currentCollegeStream: "science",
    collegesShownCount: 0,
  };

  const COLLEGES_PAGE_SIZE = 12;

  // -------------------------------------------------------------------
  // عناصر الواجهة
  // -------------------------------------------------------------------
  const el = (id) => document.getElementById(id);

  const appRoot = el("app");
  const loadedCountEl = el("loadedCount");

  const themeToggle = el("themeToggle");

  const tabSeating = el("tabSeating");
  const tabName = el("tabName");
  const tabsContainer = document.querySelector(".tabs");
  const searchInput = el("searchInput");
  const inlineClearBtn = el("inlineClearBtn");
  const suggestionsBox = el("suggestionsBox");
  const searchBtn = el("searchBtn");
  const clearBtn = el("clearBtn");
  const searchError = el("searchError");
  const connectionError = el("connectionError");

  const searchView = el("searchView");
  const listView = el("listView");
  const resultView = el("resultView");
  const notFoundView = el("notFoundView");

  const resultsListEl = el("resultsList");
  const listCountEl = el("listCount");
  const paginationEl = el("pagination");
  const backFromList = el("backFromList");

  const resultName = el("resultName");
  const resultStatus = el("resultStatus");
  const resultSeating = el("resultSeating");
  const resultTotal = el("resultTotal");
  const maxTotalField = el("maxTotalField");
  const resultMaxTotal = el("resultMaxTotal");
  const gaugeFill = el("gaugeFill");
  const gaugePercentText = el("gaugePercentText");
  const percentageNote = el("percentageNote");
  const extraFieldsSection = el("extraFieldsSection");
  const confettiCanvas = el("confettiCanvas");

  const collegesSection = el("collegesSection");
  const collegesList = el("collegesList");
  const noCollegesMsg = el("noCollegesMsg");
  const showMoreCollegesBtn = el("showMoreColleges");
  const streamTabButtons = document.querySelectorAll(".stream-tab");

  const printBtn = el("printBtn");
  const newSearchBtn = el("newSearchBtn");
  const backFromNotFound = el("backFromNotFound");
  const notFoundMsg = el("notFoundMsg");

  const adminPanel = el("adminPanel");
  const adminContent = el("adminContent");
  const closeAdmin = el("closeAdmin");

  const toastEl = el("toast");

  const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 60;

  // =====================================================================
  // 1) دوال تطبيع النص العربي (تُستخدم فقط لعرض الاقتراحات الأولية محليًا؛
  //    المطابقة الفعلية والنهائية تتم دائمًا على الخادم)
  // =====================================================================
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

  // =====================================================================
  // 2) الاتصال بالـ API
  // =====================================================================
  async function apiSearchSeating(query) {
    const url = API_ENDPOINT + "?type=seating&q=" + encodeURIComponent(query);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP_" + res.status);
    const data = await res.json();
    return data.student || null;
  }

  async function apiSearchName(query, limit) {
    const url =
      API_ENDPOINT + "?type=name&q=" + encodeURIComponent(query) + (limit ? "&limit=" + limit : "");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP_" + res.status);
    const data = await res.json();
    return data.results || [];
  }

  async function apiMeta() {
    const res = await fetch(API_ENDPOINT + "?type=meta", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP_" + res.status);
    const data = await res.json();
    return data.stats || null;
  }

  // =====================================================================
  // 3) حساب النسبة المئوية (يعمل محليًا فور استلام بيانات الطالب من الخادم)
  // =====================================================================
  function computePercentage(student) {
    if (student.totalDegree === null || student.totalDegree === undefined) return null;
    const total = Number(student.totalDegree);
    if (isNaN(total)) return null;

    let maxTotal, source;
    if (student.maxTotal !== null && student.maxTotal !== undefined && Number(student.maxTotal) > 0) {
      maxTotal = Number(student.maxTotal);
      source = "file";
    } else {
      maxTotal = DEFAULT_MAX_TOTAL;
      source = "default";
    }
    return { percentage: (total / maxTotal) * 100, maxTotal, source };
  }

  // =====================================================================
  // 4) العرض
  // =====================================================================
  function hideAllViews() {
    searchView.classList.remove("hidden");
    listView.classList.add("hidden");
    resultView.classList.add("hidden");
    notFoundView.classList.add("hidden");
  }

  function showSearchView() {
    hideAllViews();
    searchError.classList.add("hidden");
    connectionError.classList.add("hidden");
    hideSuggestions();
  }

  function showNotFound(message) {
    searchView.classList.add("hidden");
    listView.classList.add("hidden");
    resultView.classList.add("hidden");
    notFoundView.classList.remove("hidden");
    notFoundMsg.textContent = message;
  }

  function classifyStatus(status) {
    const s = (status || "").trim();
    if (!s) return "status-other";
    if (s.includes("ناجح")) return "status-pass";
    if (s.includes("راسب") || s.includes("غياب")) return "status-fail";
    return "status-other";
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    requestAnimationFrame(() => toastEl.classList.add("show"));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => toastEl.classList.add("hidden"), 300);
    }, 2400);
  }

  function renderStudentCard(student) {
    searchView.classList.add("hidden");
    listView.classList.add("hidden");
    notFoundView.classList.add("hidden");
    resultView.classList.remove("hidden");
    resultView.classList.remove("view-transition");
    void resultView.offsetWidth;
    resultView.classList.add("view-transition");

    resultName.textContent = student.name || "—";
    const statusClass = classifyStatus(student.status);
    resultStatus.textContent = student.status || "غير محدد";
    resultStatus.className = "status-badge " + statusClass;

    resultSeating.textContent = student.seatingNo || "—";
    resultTotal.textContent = student.totalDegree !== null ? student.totalDegree : "غير متوفر";

    const pctInfo = computePercentage(student);

    if (pctInfo) {
      resultMaxTotal.textContent = pctInfo.maxTotal;
      maxTotalField.classList.remove("hidden");

      const pct = Math.max(0, Math.min(100, pctInfo.percentage));
      const offset = GAUGE_CIRCUMFERENCE * (1 - pct / 100);

      gaugeFill.style.transition = "none";
      gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
      void gaugeFill.offsetWidth;
      gaugeFill.style.transition = "";

      gaugeFill.classList.remove("grade-fail", "grade-warn");
      if (statusClass === "status-fail") gaugeFill.classList.add("grade-fail");
      else if (statusClass === "status-other") gaugeFill.classList.add("grade-warn");

      requestAnimationFrame(() => {
        gaugeFill.style.strokeDashoffset = offset;
      });

      animateCountUp(gaugePercentText, pct);

      percentageNote.textContent =
        pctInfo.source === "file"
          ? "النسبة محسوبة: المجموع ÷ النهاية العظمى (من ملف البيانات) × 100"
          : "النسبة محسوبة تلقائيًا بقسمة المجموع على 320 (المجموع الكلي الرسمي لنظام الثانوية العامة الحديث 2026)، لعدم وجود عمود نهاية عظمى صريح في الملف.";

      state.currentStudentPercentage = pct;
      state.collegesShownCount = COLLEGES_PAGE_SIZE;
      renderQualifyingColleges();
    } else {
      gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
      gaugePercentText.textContent = "--%";
      maxTotalField.classList.add("hidden");
      percentageNote.textContent = "تعذّر حساب النسبة المئوية لعدم توفر مجموع رقمي صالح لهذا الطالب.";
      state.currentStudentPercentage = null;
      collegesSection.classList.add("hidden");
    }

    extraFieldsSection.innerHTML = "";
    const extraKeys = Object.keys(student.extra || {});
    if (extraKeys.length > 0) {
      const title = document.createElement("h3");
      title.textContent = "بيانات إضافية من ملف النتيجة";
      extraFieldsSection.appendChild(title);

      const table = document.createElement("table");
      table.className = "extra-table";
      extraKeys.forEach((key) => {
        const tr = document.createElement("tr");
        const tdKey = document.createElement("td");
        tdKey.textContent = key;
        const tdVal = document.createElement("td");
        tdVal.textContent = student.extra[key];
        tr.appendChild(tdKey);
        tr.appendChild(tdVal);
        table.appendChild(tr);
      });
      extraFieldsSection.appendChild(table);
    }

    if (student.duplicateCount && student.duplicateCount > 1) {
      const warn = document.createElement("p");
      warn.className = "search-error";
      warn.style.marginTop = "14px";
      warn.textContent =
        "تنبيه: تم العثور على أكثر من سجل بنفس رقم الجلوس في ملف البيانات. الرجاء مراجعة المسؤول للتأكد من دقة البيانات.";
      extraFieldsSection.appendChild(warn);
    }

    if (statusClass === "status-pass") {
      launchConfetti();
    }
  }

  function animateCountUp(elm, target) {
    const duration = 900;
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = (target * eased).toFixed(2);
      elm.textContent = value + "%";
      if (t < 1) requestAnimationFrame(step);
      else elm.textContent = target.toFixed(2) + "%";
    }
    requestAnimationFrame(step);
  }

  function renderNameResultsList(results, page) {
    searchView.classList.add("hidden");
    resultView.classList.add("hidden");
    notFoundView.classList.add("hidden");
    listView.classList.remove("hidden");

    state.currentNameResults = results;
    state.currentPage = page;

    listCountEl.textContent = "تم العثور على " + results.length.toLocaleString("ar-EG") + " نتيجة مطابقة";

    const start = (page - 1) * RESULTS_PER_PAGE;
    const pageItems = results.slice(start, start + RESULTS_PER_PAGE);

    resultsListEl.innerHTML = "";
    pageItems.forEach((student, idx) => {
      const item = document.createElement("div");
      item.className = "result-list-item";
      item.style.animationDelay = Math.min(idx * 35, 300) + "ms";
      item.setAttribute("role", "option");
      item.tabIndex = 0;

      const main = document.createElement("div");
      main.className = "item-main";

      const nameEl = document.createElement("span");
      nameEl.className = "item-name";
      nameEl.textContent = student.name;

      const subEl = document.createElement("span");
      subEl.className = "item-sub";
      let subParts = ["رقم الجلوس: " + student.seatingNo];
      if (student.extra && student.extra["المدرسة"]) {
        subParts.push(student.extra["المدرسة"]);
      }
      subEl.textContent = subParts.join(" — ");

      main.appendChild(nameEl);
      main.appendChild(subEl);

      const arrow = document.createElement("span");
      arrow.className = "item-arrow";
      arrow.textContent = "‹";

      item.appendChild(main);
      item.appendChild(arrow);

      const open = () => renderStudentCard(student);
      item.addEventListener("click", open);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });

      resultsListEl.appendChild(item);
    });

    renderPagination(results.length, page);
  }

  function renderPagination(totalItems, currentPage) {
    paginationEl.innerHTML = "";
    const totalPages = Math.ceil(totalItems / RESULTS_PER_PAGE);
    if (totalPages <= 1) return;

    const makeBtn = (label, page, disabled, active) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "page-btn" + (active ? " active" : "");
      btn.textContent = label;
      btn.disabled = !!disabled;
      btn.addEventListener("click", () => {
        renderNameResultsList(state.currentNameResults, page);
        listView.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return btn;
    };

    paginationEl.appendChild(makeBtn("السابق", currentPage - 1, currentPage <= 1, false));

    const windowSize = 5;
    let startPage = Math.max(1, currentPage - Math.floor(windowSize / 2));
    let endPage = Math.min(totalPages, startPage + windowSize - 1);
    startPage = Math.max(1, endPage - windowSize + 1);

    for (let p = startPage; p <= endPage; p++) {
      paginationEl.appendChild(makeBtn(String(p), p, false, p === currentPage));
    }

    paginationEl.appendChild(makeBtn("التالي", currentPage + 1, currentPage >= totalPages, false));
  }

  // =====================================================================
  // 4.5) الكليات المؤهَّل لها الطالب (تنسيق العام الماضي 2025)
  // =====================================================================
  function getTansiqData() {
    return Array.isArray(window.TANSIQ_2025) ? window.TANSIQ_2025 : [];
  }

  function renderQualifyingColleges() {
    const percentage = state.currentStudentPercentage;
    const data = getTansiqData();

    if (percentage === null || data.length === 0) {
      collegesSection.classList.add("hidden");
      return;
    }

    collegesSection.classList.remove("hidden");

    const stream = state.currentCollegeStream;
    const matches = data.filter((r) => r.stream === stream && r.pct <= percentage);

    collegesList.innerHTML = "";

    if (matches.length === 0) {
      noCollegesMsg.classList.remove("hidden");
      showMoreCollegesBtn.classList.add("hidden");
      return;
    }

    noCollegesMsg.classList.add("hidden");

    const shown = matches.slice(0, state.collegesShownCount);
    shown.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "college-item";
      row.style.animationDelay = Math.min(idx * 30, 260) + "ms";

      const info = document.createElement("div");
      info.className = "college-info";

      const uniEl = document.createElement("span");
      uniEl.className = "college-uni";
      uniEl.textContent = item.uni;

      const colEl = document.createElement("span");
      colEl.className = "college-name";
      colEl.textContent = item.col;

      info.appendChild(colEl);
      info.appendChild(uniEl);

      const badge = document.createElement("span");
      badge.className = "college-pct-badge";
      badge.textContent = item.pct + "%";

      row.appendChild(info);
      row.appendChild(badge);
      collegesList.appendChild(row);
    });

    showMoreCollegesBtn.classList.toggle("hidden", matches.length <= state.collegesShownCount);
  }

  streamTabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      streamTabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentCollegeStream = btn.getAttribute("data-stream");
      state.collegesShownCount = COLLEGES_PAGE_SIZE;
      renderQualifyingColleges();
    });
  });

  showMoreCollegesBtn.addEventListener("click", () => {
    state.collegesShownCount += COLLEGES_PAGE_SIZE;
    renderQualifyingColleges();
  });

  // =====================================================================
  // 5) الاقتراحات الفورية (Autocomplete)
  // =====================================================================
  let suggestionDebounceTimer = null;
  let activeSuggestionIndex = -1;
  let suggestionRequestToken = 0;

  function hideSuggestions() {
    suggestionsBox.classList.add("hidden");
    suggestionsBox.innerHTML = "";
    activeSuggestionIndex = -1;
  }

  async function renderSuggestions(query) {
    if (state.currentMode !== "name" || !query.trim()) {
      hideSuggestions();
      return;
    }

    const myToken = ++suggestionRequestToken;
    let results;
    try {
      results = await apiSearchName(query, MAX_SUGGESTIONS + 30);
    } catch (e) {
      return;
    }

    if (myToken !== suggestionRequestToken) return;

    if (results.length === 0) {
      hideSuggestions();
      return;
    }

    suggestionsBox.innerHTML = "";
    const shown = results.slice(0, MAX_SUGGESTIONS);
    shown.forEach((student) => {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      item.setAttribute("role", "option");

      const nameEl = document.createElement("span");
      nameEl.className = "s-name";
      nameEl.textContent = student.name;

      const seatEl = document.createElement("span");
      seatEl.className = "s-seat";
      seatEl.textContent = student.seatingNo;

      item.appendChild(nameEl);
      item.appendChild(seatEl);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        hideSuggestions();
        renderStudentCard(student);
      });

      suggestionsBox.appendChild(item);
    });

    if (results.length > MAX_SUGGESTIONS) {
      const more = document.createElement("div");
      more.className = "suggestion-more";
      more.textContent =
        "و " + (results.length - MAX_SUGGESTIONS).toLocaleString("ar-EG") + " نتيجة أخرى — اضغط عرض النتيجة لعرض الكل";
      suggestionsBox.appendChild(more);
    }

    suggestionsBox.classList.remove("hidden");
  }

  function moveSuggestionHighlight(delta) {
    const items = Array.from(suggestionsBox.querySelectorAll(".suggestion-item"));
    if (items.length === 0) return;
    items.forEach((it) => it.classList.remove("active-highlight"));
    activeSuggestionIndex = (activeSuggestionIndex + delta + items.length) % items.length;
    items[activeSuggestionIndex].classList.add("active-highlight");
    items[activeSuggestionIndex].scrollIntoView({ block: "nearest" });
  }

  function selectHighlightedSuggestion() {
    const items = Array.from(suggestionsBox.querySelectorAll(".suggestion-item"));
    if (activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
      items[activeSuggestionIndex].dispatchEvent(new MouseEvent("mousedown"));
      return true;
    }
    return false;
  }

  // =====================================================================
  // 6) القصاصات الاحتفالية (Confetti) عند النجاح
  // =====================================================================
  function launchConfetti() {
    const canvas = confettiCanvas;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const colors = ["#0d8f6c", "#22c08e", "#f2b134", "#e0663c", "#3d7dd6"];
    const pieces = Array.from({ length: 70 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 5 + Math.random() * 5,
      h: 8 + Math.random() * 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      speed: 2 + Math.random() * 3,
      drift: (Math.random() - 0.5) * 2,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
    }));

    let frame = 0;
    const maxFrames = 130;

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach((p) => {
        p.y += p.speed;
        p.x += p.drift;
        p.rotation += p.rotationSpeed;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      frame++;
      if (frame < maxFrames) {
        requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    requestAnimationFrame(draw);
  }

  // =====================================================================
  // 7) منطق البحث الرئيسي
  // =====================================================================
  async function performSearch() {
    searchError.classList.add("hidden");
    connectionError.classList.add("hidden");
    hideSuggestions();
    const query = searchInput.value.trim();

    if (!query) {
      searchError.textContent =
        state.currentMode === "seating" ? "الرجاء إدخال رقم الجلوس." : "الرجاء إدخال اسم الطالب أو جزء منه.";
      searchError.classList.remove("hidden");
      return;
    }

    searchBtn.disabled = true;
    searchBtn.classList.add("btn-loading");
    try {
      if (state.currentMode === "seating") {
        const student = await apiSearchSeating(query);
        if (student) {
          renderStudentCard(student);
        } else {
          showNotFound("لا يوجد طالب مسجّل بهذا رقم الجلوس. الرجاء التأكد من الرقم والمحاولة مرة أخرى.");
        }
      } else {
        const results = await apiSearchName(query);
        if (results.length === 0) {
          showNotFound("لم يتم العثور على أي طالب بهذا الاسم. حاول كتابة جزء أبسط من الاسم.");
        } else if (results.length === 1) {
          renderStudentCard(results[0]);
        } else {
          renderNameResultsList(results, 1);
        }
      }
    } catch (err) {
      connectionError.classList.remove("hidden");
    } finally {
      searchBtn.disabled = false;
      searchBtn.classList.remove("btn-loading");
    }
  }

  function resetSearch() {
    searchInput.value = "";
    searchError.classList.add("hidden");
    connectionError.classList.add("hidden");
    inlineClearBtn.classList.add("hidden");
    showSearchView();
    searchInput.focus();
  }

  function switchMode(mode) {
    state.currentMode = mode;
    tabSeating.classList.toggle("active", mode === "seating");
    tabName.classList.toggle("active", mode === "name");
    tabsContainer.setAttribute("data-mode", mode === "name" ? "name-active" : "seating-active");
    searchInput.placeholder = mode === "seating" ? "أدخل رقم الجلوس" : "أدخل اسم الطالب أو جزءًا منه";
    searchInput.value = "";
    inlineClearBtn.classList.add("hidden");
    searchError.classList.add("hidden");
    hideSuggestions();
    searchInput.focus();
  }

  // =====================================================================
  // 8) لوحة التحقق الداخلية
  // =====================================================================
  async function renderAdminPanel() {
    adminContent.innerHTML = "<p>جاري التحميل...</p>";
    let stats;
    try {
      stats = await apiMeta();
    } catch (e) {
      adminContent.innerHTML = "<p>تعذّر الاتصال بالخادم لجلب الإحصائيات.</p>";
      return;
    }
    if (!stats) {
      adminContent.innerHTML = "<p>لا توجد بيانات إحصائية متاحة.</p>";
      return;
    }

    adminContent.innerHTML = "";
    const dl = document.createElement("dl");
    const addRow = (label, value) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    };

    addRow("عدد الطلاب الفعلي المحمّل", stats.totalStudents);
    addRow("عدد أرقام الجلوس الفريدة", stats.uniqueSeatingCount);
    addRow("عدد أرقام الجلوس المكررة", stats.duplicateSeatingNumbers);
    if (stats.emptyRowsExcluded !== undefined) {
      addRow("عدد الصفوف الفارغة المستبعدة", stats.emptyRowsExcluded);
    }
    if (stats.incompleteRecords !== undefined) {
      addRow("عدد السجلات الناقصة (حقول مفقودة)", stats.incompleteRecords);
    }
    if (stats.sheetsRead && stats.sheetsRead.length) {
      addRow("أوراق العمل المقروءة", stats.sheetsRead.join("، "));
    }
    if (stats.columnsDetected && stats.columnsDetected.length) {
      addRow("الأعمدة المكتشفة", stats.columnsDetected.join("، "));
    }
    adminContent.appendChild(dl);

    if (stats.duplicateSeatingNumbers > 0) {
      const alertBox = document.createElement("div");
      alertBox.className = "admin-alert";
      alertBox.textContent =
        "تحذير: يوجد " + stats.duplicateSeatingNumbers + " رقم جلوس مكرر في الملف. لم يتم حذف أي سجل تلقائيًا.";
      adminContent.appendChild(alertBox);
    }
  }

  function toggleAdminPanel(show) {
    if (show) renderAdminPanel();
    adminPanel.classList.toggle("hidden", !show);
  }

  // =====================================================================
  // 9) المظهر الليلي / النهاري
  // =====================================================================
  function applyTheme(theme) {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try {
      localStorage.setItem("resultAppTheme", theme);
    } catch (e) {
      /* تجاهل */
    }
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("resultAppTheme");
    } catch (e) {
      saved = null;
    }
    if (saved) {
      applyTheme(saved);
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      applyTheme("dark");
    }
  }

  themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  });

  // =====================================================================
  // 10) ربط الأحداث
  // =====================================================================
  tabSeating.addEventListener("click", () => switchMode("seating"));
  tabName.addEventListener("click", () => switchMode("name"));

  searchBtn.addEventListener("click", performSearch);
  clearBtn.addEventListener("click", resetSearch);

  searchInput.addEventListener("input", () => {
    inlineClearBtn.classList.toggle("hidden", !searchInput.value);
    if (state.currentMode === "name") {
      clearTimeout(suggestionDebounceTimer);
      suggestionDebounceTimer = setTimeout(() => renderSuggestions(searchInput.value), 220);
    }
  });

  searchInput.addEventListener("keydown", (e) => {
    const suggestionsVisible = !suggestionsBox.classList.contains("hidden");
    if (e.key === "ArrowDown" && suggestionsVisible) {
      e.preventDefault();
      moveSuggestionHighlight(1);
    } else if (e.key === "ArrowUp" && suggestionsVisible) {
      e.preventDefault();
      moveSuggestionHighlight(-1);
    } else if (e.key === "Enter") {
      if (suggestionsVisible && activeSuggestionIndex >= 0) {
        if (selectHighlightedSuggestion()) return;
      }
      performSearch();
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  inlineClearBtn.addEventListener("click", () => {
    searchInput.value = "";
    inlineClearBtn.classList.add("hidden");
    hideSuggestions();
    searchInput.focus();
  });

  document.addEventListener("click", (e) => {
    if (!suggestionsBox.contains(e.target) && e.target !== searchInput) {
      hideSuggestions();
    }
  });

  backFromList.addEventListener("click", resetSearch);
  backFromNotFound.addEventListener("click", resetSearch);
  newSearchBtn.addEventListener("click", resetSearch);

  printBtn.addEventListener("click", () => window.print());

  closeAdmin.addEventListener("click", () => toggleAdminPanel(false));

  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "a" || e.key === "A" || e.key === "ا")) {
      toggleAdminPanel(adminPanel.classList.contains("hidden"));
    }
  });

  // =====================================================================
  // 11) بدء التشغيل — الصفحة جاهزة للبحث فورًا، لا يوجد أي تحميل حاجب
  // =====================================================================
  initTheme();
  showSearchView();
  searchInput.focus();

  // طلب خفيف وغير حاجب لعرض عدد الطلاب المحمّلين (لا يؤخر ظهور الواجهة أبدًا)
  apiMeta()
    .then((stats) => {
      if (stats && stats.totalStudents) {
        loadedCountEl.textContent =
          "قاعدة بيانات النتيجة تحتوي " + stats.totalStudents.toLocaleString("ar-EG") + " طالبًا";
        loadedCountEl.classList.remove("hidden");
      }
    })
    .catch(() => {
      /* لا شيء — البحث نفسه سيظهر رسالة خطأ الاتصال عند الحاجة الفعلية */
    });
})();
