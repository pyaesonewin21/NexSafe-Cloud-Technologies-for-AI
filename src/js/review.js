/* =========================================================
   NexSafe — review.js
   Staff Review Queue using the REAL AWS/RDS backend.
   Depends on js/common.js being loaded first.
   ========================================================= */

if (requireRole("staff")) {
  setupAppUI();
  showFlashMessageIfAny();

  function loadReviewQueue() {
    var grid = $("#reviewGrid");

    grid.innerHTML = "";
    $("#reviewEmpty").hidden = true;

    // REAL GET /reports -> API Gateway -> Lambda -> RDS.
    awsApi.listReports().then(function (response) {
      if (response.statusCode !== 200 || !Array.isArray(response.body)) {
        $("#reviewEmpty").hidden = false;
        showToast("Unable to load review queue", "error");
        return;
      }

      var submittedReports =
        response.body.filter(function (report) {
          return report.status === "submitted";
        });

      $("#reviewEmpty").hidden =
        submittedReports.length > 0;

      submittedReports.forEach(function (report, index) {
        grid.appendChild(
          createReportCard(report, index)
        );
      });
    });
  }

  // After staff changes status in the shared modal,
  // re-fetch so reviewed items leave the queue immediately.
  onDataChanged = loadReviewQueue;
  loadReviewQueue();
}
