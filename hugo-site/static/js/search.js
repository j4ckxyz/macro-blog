/* Lightweight client-side fuzzy search over /search-index.json.
   Subsequence + token scoring — no dependencies, instant on a personal site. */
(function () {
  var input = document.getElementById("mb-search");
  var box = document.getElementById("mb-search-results");
  if (!input || !box) return;

  var index = null;
  var loading = false;

  function load() {
    if (index || loading) return Promise.resolve();
    loading = true;
    var base = document.querySelector("base") ? document.querySelector("base").href : "/";
    return fetch("/search-index.json")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) { index = Array.isArray(data) ? data : []; })
      .catch(function () { index = []; })
      .finally(function () { loading = false; });
  }

  // Fuzzy subsequence test: are all chars of needle in haystack, in order?
  function subseq(needle, hay) {
    var i = 0;
    for (var j = 0; j < hay.length && i < needle.length; j++) {
      if (hay[j] === needle[i]) i++;
    }
    return i === needle.length;
  }

  function score(q, item) {
    var title = (item.title || "").toLowerCase();
    var text = (item.text || "").toLowerCase();
    var tags = (item.tags || []).join(" ").toLowerCase();
    var hay = title + " " + tags + " " + text;
    if (hay.indexOf(q) === -1 && !subseq(q, hay)) return 0;
    var s = 0;
    if (title.indexOf(q) === 0) s += 100;        // title prefix
    else if (title.indexOf(q) !== -1) s += 60;   // title contains
    if (tags.indexOf(q) !== -1) s += 40;
    if (text.indexOf(q) !== -1) s += 20;         // body contains
    else if (subseq(q, hay)) s += 5;             // fuzzy only
    // Prefer shorter titles / more recent posts as a tiebreaker.
    s += Math.max(0, 20 - title.length / 4);
    if (item.date) s += (item.date > "2000" ? 1 : 0);
    return s;
  }

  function render(q) {
    if (!q || !index) { box.hidden = true; box.innerHTML = ""; return; }
    var ql = q.toLowerCase().trim();
    var results = index
      .map(function (it) { return { it: it, s: score(ql, it) }; })
      .filter(function (r) { return r.s > 0; })
      .sort(function (a, b) { return b.s - a.s || (b.it.date || "").localeCompare(a.it.date || ""); })
      .slice(0, 8);
    if (!results.length) {
      box.innerHTML = '<div class="nav-search-empty">No matches</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = results.map(function (r) {
      var it = r.it;
      var label = it.title && it.title.trim() ? it.title : (it.text || "").slice(0, 60) + "…";
      return '<a class="nav-search-item" href="' + it.url + '">' +
        '<span class="nav-search-title">' + escapeHtml(label) + '</span>' +
        '<span class="nav-search-date">' + (it.date || "") + "</span></a>";
    }).join("");
    box.hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  input.addEventListener("focus", load);
  input.addEventListener("input", function () { load().then(function () { render(input.value); }); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { input.value = ""; render(""); input.blur(); }
    if (e.key === "Enter") {
      var first = box.querySelector(".nav-search-item");
      if (first) window.location.href = first.getAttribute("href");
    }
  });
  document.addEventListener("click", function (e) {
    if (!box.contains(e.target) && e.target !== input) box.hidden = true;
  });
})();
