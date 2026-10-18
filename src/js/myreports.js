/* =========================================================
   NexSafe — myreports.js
   Student's own reports from the REAL AWS/RDS backend.
   Depends on js/common.js being loaded first.
   ========================================================= */

if (requireRole("student")) {
  setupAppUI();
  showFlashMessageIfAny();

  var myReportsGrid = $("#myReportsGrid");
  var myReportsEmpty = $("#myReportsEmpty");

  function loadMyReports() {
    myReportsGrid.innerHTML = "";
    myReportsEmpty.hidden = true;

    // REAL GET /reports/mine?email=...
    // -> API Gateway -> Lambda -> RDS.
    awsApi.getMyReports(currentUser.email).then(function (response) {
      if (response.statusCode !== 200 || !Array.isArray(response.body)) {
        myReportsEmpty.hidden = false;
        showToast("Unable to load your reports", "error");
        return;
      }

      var myReports = response.body.slice();

      // Keep common.js's shared cache aligned with what this page shows.
      reports = myReports.slice();

      myReportsEmpty.hidden = myReports.length > 0;

      myReports.forEach(function (report, index) {
        myReportsGrid.appendChild(
          createReportCard(report, index)
        );
      });
    });
  }

  onDataChanged = loadMyReports;
  loadMyReports();
}
