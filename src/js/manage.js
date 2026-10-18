/* =========================================================
   NexSafe — manage.js
   Staff report management using the REAL AWS/RDS backend.
   Depends on js/common.js being loaded first.
   ========================================================= */

if (requireRole("staff")) {
  setupAppUI();
  showFlashMessageIfAny();

  var manageSearchQuery = "";
  var manageStatusValue = "all";
  var manageReports = [];

  function loadManageReports() {
    $("#manageSearch").value = manageSearchQuery;
    $("#manageStatusFilter").value = manageStatusValue;

    // REAL GET /reports -> API Gateway -> Lambda -> RDS.
    awsApi.listReports().then(function (response) {
      if (response.statusCode !== 200 || !Array.isArray(response.body)) {
        manageReports = [];
        renderManageList();
        showToast("Unable to load reports", "error");
        return;
      }

      manageReports = response.body.slice();
      renderManageList();
    });
  }

  function renderManageList() {
    var query = manageSearchQuery.toLowerCase();

    var list = manageReports.filter(function (report) {
      var matchesStatus =
        manageStatusValue === "all" ||
        report.status === manageStatusValue;

      var title =
        (report.title || "").toLowerCase();

      var location =
        (report.location || "").toLowerCase();

      var matchesSearch =
        !query ||
        title.indexOf(query) !== -1 ||
        location.indexOf(query) !== -1;

      return matchesStatus && matchesSearch;
    });

    var container = $("#manageList");

    container.innerHTML = "";
    $("#manageEmpty").hidden = list.length > 0;

    list.forEach(function (report, index) {
      container.appendChild(
        createReportCard(report, index)
      );
    });
  }

  // Re-fetch real RDS data after status/priority/staff-update/delete.
  onDataChanged = loadManageReports;

  $("#manageSearch").addEventListener("input", function (e) {
    manageSearchQuery = e.target.value;
    renderManageList();
  });

  $("#manageStatusFilter").addEventListener("change", function (e) {
    manageStatusValue = e.target.value;
    renderManageList();
  });

  loadManageReports();
}
