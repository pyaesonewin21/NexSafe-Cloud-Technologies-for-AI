/* =========================================================
   NexSafe — feed.js
   Loads the public report feed from the REAL AWS/RDS backend.
   Depends on js/common.js being loaded first.
   ========================================================= */

if (requireAuth()) {
  setupAppUI();
  showFlashMessageIfAny();

  var currentFilter = "all";
  var feedReports = [];

  var feedGrid = $("#feedGrid");
  var feedEmpty = $("#feedEmpty");
  var feedCount = $("#feedCount");
  var feedLoading = $("#feedLoading");

  function loadFeed() {
    feedGrid.innerHTML = "";
    feedEmpty.hidden = true;
    feedLoading.hidden = false;

    // REAL GET /reports -> API Gateway -> Lambda -> RDS.
    awsApi.listReports().then(function (response) {
      feedLoading.hidden = true;

      if (response.statusCode !== 200 || !Array.isArray(response.body)) {
        feedCount.textContent = "0 reports";
        feedEmpty.hidden = false;
        showToast("Unable to load reports", "error");
        return;
      }

      feedReports = response.body.slice();
      renderFeedList(feedReports);
    });
  }

  function renderFeedList(all) {
    var list =
      currentFilter === "all"
        ? all
        : all.filter(function (r) {
            return r.category === currentFilter;
          });

    feedGrid.innerHTML = "";
    feedEmpty.hidden = list.length > 0;

    if (list.length === 0) {
      feedCount.textContent = "0 reports";
      return;
    }

    feedCount.textContent =
      list.length +
      " " +
      (list.length === 1 ? "report" : "reports");

    list.forEach(function (r, i) {
      feedGrid.appendChild(createReportCard(r, i));
    });
  }

  // Re-fetch from RDS after an update/delete.
  onDataChanged = loadFeed;

  $$(".filter").forEach(function (btn) {
    btn.addEventListener("click", function () {
      $$(".filter").forEach(function (f) {
        f.classList.remove("is-active");
      });

      btn.classList.add("is-active");
      currentFilter = btn.dataset.filter;
      renderFeedList(feedReports);
    });
  });

  loadFeed();
}
