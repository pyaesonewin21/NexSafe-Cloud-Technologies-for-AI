/* =========================================================
   NexSafe — home.js
   Student/staff Home page using the REAL AWS API/RDS backend.
   Depends on js/common.js being loaded first.
   ========================================================= */

if (requireAuth()) {
  setupAppUI();
  showFlashMessageIfAny();

  // Reload Home whenever common.js tells us report data changed.
  onDataChanged = loadHome;

  function animateNum(el, target) {
    if (!el) return;

    var dur = 1000;
    var start = performance.now();

    function tick(now) {
      var p = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString();

      if (p < 1) {
        requestAnimationFrame(tick);
      }
    }

    requestAnimationFrame(tick);
  }

  function loadHome() {
    var isStaff = currentUser && currentUser.role === "staff";

    $("#homeStaffContent").hidden = !isStaff;
    $("#homeStudentContent").hidden = isStaff;

    if (isStaff) {
      loadStaffHome();
    } else {
      loadStudentHome();
    }
  }

  /* =====================================================
     STAFF HOME
     GET /reports -> API Gateway -> Lambda -> RDS
     ===================================================== */
  function loadStaffHome() {
    var name = currentUser ? currentUser.name.split(" ")[0] : "";
    $("#homeGreeting").textContent =
      name ? "Welcome back, " + name : "Home";

    awsApi.listReports().then(function (response) {
      if (response.statusCode !== 200 || !Array.isArray(response.body)) {
        showToast("Unable to load reports", "error");

        animateNum($("#homeNeedsReview"), 0);
        animateNum($("#homeHighPriority"), 0);
        animateNum($("#homeInProgress"), 0);

        $("#homeUrgentGrid").innerHTML = "";
        $("#homeUrgentEmpty").hidden = false;
        return;
      }

      // listReports() already updates the global reports cache in common.js.
      var allReports = response.body;

      var needsReview = allReports.filter(function (r) {
        return r.status === "submitted";
      });

      var highPriorityOpen = allReports.filter(function (r) {
        return (
          r.priority === "high" &&
          r.status !== "resolved" &&
          r.status !== "rejected"
        );
      });

      var inProgress = allReports.filter(function (r) {
        return r.status === "in_progress";
      });

      animateNum($("#homeNeedsReview"), needsReview.length);
      animateNum($("#homeHighPriority"), highPriorityOpen.length);
      animateNum($("#homeInProgress"), inProgress.length);

      // Combine urgent lists without duplicate report IDs.
      var seenIds = {};
      var urgent = [];

      needsReview.concat(highPriorityOpen).forEach(function (r) {
        if (!seenIds[r.id]) {
          seenIds[r.id] = true;
          urgent.push(r);
        }
      });

      urgent.sort(function (a, b) {
        return new Date(b.created_at) - new Date(a.created_at);
      });

      urgent = urgent.slice(0, 6);

      var grid = $("#homeUrgentGrid");
      grid.innerHTML = "";
      $("#homeUrgentEmpty").hidden = urgent.length > 0;

      urgent.forEach(function (r, i) {
        grid.appendChild(createReportCard(r, i));
      });
    });
  }

  /* =====================================================
     STUDENT NOTIFICATIONS SHOWN INSIDE THE WEBSITE

     For now these are derived from the student's RDS reports.
     Later we will add Amazon SNS for real external notifications.
     ===================================================== */
  function getStudentNotifications(studentReports) {
    var mine = Array.isArray(studentReports) ? studentReports : [];
    var notifs = [];

    mine.forEach(function (r) {
      // A brand-new "submitted" report does not need a notification.
      // Once staff changes its status, show an update here.
      if (r.status !== "submitted") {
        var s = statusMap[r.status] || statusMap.submitted;

        var notificationText =
          'Your report "' +
          r.title +
          '" is now ' +
          s.label +
          ".";

        if (r.staff_update) {
          notificationText +=
            " Staff update: " + r.staff_update;
        }

        notifs.push({
          text: notificationText,
          time: r.updated_at || r.created_at,
          reportId: r.id
        });
      }
    });

    notifs.sort(function (a, b) {
      return new Date(b.time) - new Date(a.time);
    });

    return notifs.slice(0, 6);
  }

  /* =====================================================
     STUDENT HOME
     GET /reports/mine?email=... -> API Gateway -> Lambda -> RDS
     ===================================================== */
  function loadStudentHome() {
    var name = currentUser ? currentUser.name.split(" ")[0] : "";

    $("#studentHomeGreeting").textContent =
      name
        ? "Welcome back, " + name + "!"
        : "Welcome back!";

    awsApi.getMyReports(currentUser.email).then(function (response) {
      if (response.statusCode !== 200 || !Array.isArray(response.body)) {
        showToast("Unable to load your recent reports", "error");

        $("#studentRecentGrid").innerHTML = "";
        $("#studentRecentEmpty").hidden = false;

        $("#studentNotifList").innerHTML = "";
        $("#studentNotifEmpty").hidden = false;
        return;
      }

      var mine = response.body.slice();

      // Keep the shared cache in sync so notification clicks and
      // findReportById() can open the correct RDS report.
      reports = mine.slice();

      mine.sort(function (a, b) {
        return new Date(b.created_at) - new Date(a.created_at);
      });

      // Home intentionally shows only the latest 4 reports.
      var recent = mine.slice(0, 4);

      var grid = $("#studentRecentGrid");
      grid.innerHTML = "";
      $("#studentRecentEmpty").hidden = recent.length > 0;

      recent.forEach(function (r, i) {
        grid.appendChild(createReportCard(r, i));
      });

      // Render in-app notification summaries from the same RDS data.
      var notifs = getStudentNotifications(mine);
      var list = $("#studentNotifList");

      list.innerHTML = "";
      $("#studentNotifEmpty").hidden = notifs.length > 0;

      notifs.forEach(function (n) {
        var div = document.createElement("div");
        div.className = "notif-item";

        div.innerHTML =
          '<p class="notif-item__text">' +
          escapeHtml(n.text) +
          "</p>" +
          '<p class="notif-item__time">' +
          timeAgo(n.time) +
          "</p>";

        div.addEventListener("click", function () {
          var r = findReportById(n.reportId);

          if (r) {
            openReportModal(r);
          }
        });

        list.appendChild(div);
      });
    });
  }

  loadHome();
}
