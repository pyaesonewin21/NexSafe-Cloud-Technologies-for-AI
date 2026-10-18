/*
   Loaded on EVERY page, before the page's own <page>.js file.
   Holds: DOM helpers, shared state, the AWS API layer,
   localStorage helpers, auth-guard helpers, the flash-message
   helper (for toasts that fire right before a redirect), the
   toast + back-to-top widgets, the signed-in app header
   (nav role-visibility, profile dropdown, sign out, mobile
   nav toggle), and the shared report-detail modal.
    */

var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
//Define $$ as a function that takes a selector and an optional context, and returns an array of elements matching the
// selector within the context (or document if no context is provided).
var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
//Define a functionhat finds every element matching a CSS selector and
// returns them as a proper array


/* Shared state: user from localStorage; reports loaded from the real RDS API. */
var currentUser = null;
var reports = [];


/* Page-specific JS can point this at its own "reload the list I'm showing"
   function. Shared code (status/priority updates, delete) calls it after
   changing data, so whichever page is currently open refreshes itself. */
var onDataChanged = null;
function notifyDataChanged() {
  if (typeof onDataChanged === "function") onDataChanged();
}

/* Reports now come from the real RDS backend.
   Keep only an in-memory cache for pages that need the latest loaded list. */
var AWS_API_BASE = "https://g7t2m0em5d.execute-api.ap-southeast-2.amazonaws.com/dev";

/* =========================================================
   API Gateway JWT authentication
   =========================================================
   NexSafe sends the Cognito ID token to API Gateway.
   The HTTP API JWT authorizer validates its signature,
   issuer, audience and expiry before Lambda is invoked.
*/
function getNexSafeApiToken() {
  return (
    localStorage.getItem("nexsafe_cognito_id_token") ||
    ""
  );
}

function getNexSafeApiHeaders(extraHeaders) {
  var headers = Object.assign(
    {},
    extraHeaders || {}
  );

  var token = getNexSafeApiToken();

  if (token) {
    headers.Authorization =
      "Bearer " + token;
  }

  return headers;
}


var NEXSAFE_COMMON_VERSION = "2026-08-14-labstyle-s3-final";
console.log("NexSafe common.js:", NEXSAFE_COMMON_VERSION);


/* =========================================================
   Amazon Cognito session configuration
   ========================================================= */
var COGNITO_REGION = "ap-southeast-2";
var COGNITO_USER_POOL_ID = "ap-southeast-2_7O0q41gL7";
var COGNITO_CLIENT_ID = "26s4f1lhaf0hmk39ajkik4pv20";

var COGNITO_ENDPOINT =
  "https://cognito-idp." +
  COGNITO_REGION +
  ".amazonaws.com/";

var COGNITO_ISSUER =
  "https://cognito-idp." +
  COGNITO_REGION +
  ".amazonaws.com/" +
  COGNITO_USER_POOL_ID;

function commonDecodeBase64Url(value) {
  var base64 = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (base64.length % 4) {
    base64 += "=";
  }

  var binary = atob(base64);
  var bytes = [];

  for (var i = 0; i < binary.length; i++) {
    bytes.push(
      "%" +
      ("00" + binary.charCodeAt(i).toString(16)).slice(-2)
    );
  }

  return decodeURIComponent(bytes.join(""));
}

function commonDecodeJwt(token) {
  try {
    var parts = String(token || "").split(".");
    if (parts.length !== 3) return null;

    return JSON.parse(
      commonDecodeBase64Url(parts[1])
    );
  } catch (error) {
    console.error("Unable to decode Cognito token:", error);
    return null;
  }
}

function clearStoredCognitoSession() {
  localStorage.removeItem("nexsafe_cognito_id_token");
  localStorage.removeItem("nexsafe_cognito_access_token");
  localStorage.removeItem("nexsafe_cognito_refresh_token");
  localStorage.removeItem("nexsafe_cognito_username");
  localStorage.removeItem("nexsafe_user");

  // Old mock-auth accounts are no longer used.
  localStorage.removeItem("nexsafe_accounts");

  currentUser = null;
}

function getCognitoUserFromStoredSession() {
  var idToken =
    localStorage.getItem("nexsafe_cognito_id_token");

  var claims =
    commonDecodeJwt(idToken);

  if (!claims) return null;

  var now =
    Math.floor(Date.now() / 1000);

  if (
    claims.iss !== COGNITO_ISSUER ||
    claims.aud !== COGNITO_CLIENT_ID ||
    Number(claims.exp || 0) <= now
  ) {
    return null;
  }

  var groups =
    claims["cognito:groups"] || [];

  var role = null;

  if (groups.indexOf("staff") !== -1) {
    role = "staff";
  } else if (
    groups.indexOf("students") !== -1
  ) {
    role = "student";
  }

  if (!role) return null;

  var email =
    claims.email ||
    claims["cognito:username"] ||
    "";

  var savedUser = null;

  try {
    savedUser = JSON.parse(
      localStorage.getItem("nexsafe_user") || "null"
    );
  } catch (error) {
    savedUser = null;
  }

  var name =
    claims.name ||
    (savedUser && savedUser.name) ||
    String(email)
      .split("@")[0]
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      }) ||
    "User";

  return {
    email: email,
    name: name,
    role: role,
    sub: claims.sub
  };
}

function cognitoGlobalSignOut(accessToken) {
  if (!accessToken) {
    return Promise.resolve();
  }

  return fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target":
        "AWSCognitoIdentityProviderService.GlobalSignOut"
    },
    body: JSON.stringify({
      AccessToken: accessToken
    })
  }).then(function (response) {
    // Local sign-out must still complete even if AWS returns an error.
    if (!response.ok) {
      return response
        .json()
        .catch(function () { return {}; })
        .then(function (data) {
          console.warn(
            "Cognito GlobalSignOut returned:",
            data
          );
        });
    }
  });
}


/* Convert the camelCase report returned by the Lambda API into the
   snake_case shape the existing NexSafe pages already use. */
function normalizeApiReport(report) {
  if (!report) return null;

  return {
    id: report.id,
    title: report.title,

    issue_type:
      report.issueType !== undefined
        ? report.issueType
        : report.issue_type,

    category: report.category,
    building: report.building,
    level: report.level,

    exact_location:
      report.exactLocation !== undefined
        ? report.exactLocation
        : report.exact_location,

    location: report.location,
    description: report.description,
    status: report.status,
    priority: report.priority,

    author_id:
      report.authorId !== undefined
        ? report.authorId
        : report.author_id,

    author_name:
      report.authorName !== undefined
        ? report.authorName
        : report.author_name,

    image: report.image || null,
    rekognition: report.rekognition || null,

    staff_update:
      report.staffUpdate !== undefined
        ? report.staffUpdate
        : (report.staff_update || ""),

    created_at:
      report.createdAt !== undefined
        ? report.createdAt
        : report.created_at,

    updated_at:
      report.updatedAt !== undefined
        ? report.updatedAt
        : report.updated_at
  };
}

/* Read an API response safely, including useful error messages when
   API Gateway or Lambda returns a non-2xx response. */
function readApiResponse(response) {
  return response.text().then(function (text) {
    var data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = {
          success: false,
          message: text
        };
      }
    }

    return {
      statusCode: response.status,
      ok: response.ok,
      data: data
    };
  });
}

/* Real AWS API surface:
   Browser -> API Gateway -> Lambda -> RDS MySQL
   Rekognition continues to use /analyze-image. */
var awsApi = {

  // GET /reports -> SELECT all reports from RDS.
  listReports: function () {
    return fetch(AWS_API_BASE + "/reports", {
      method: "GET",
      cache: "no-store", //helps make the request retrieve fresh data.
      headers: getNexSafeApiHeaders()
    })
      .then(readApiResponse)
      .then(function (result) {
        if (!result.ok) {
          return {
            statusCode: result.statusCode,
            body: result.data
          };
        }

        var apiReports =
          result.data && Array.isArray(result.data.reports)
            ? result.data.reports
            : [];

        reports = apiReports.map(normalizeApiReport);

        return {
          statusCode: result.statusCode,
          body: reports.slice()
        };
      })
      .catch(function (error) {
        console.error("AWS list reports error:", error);

        return {
          statusCode: 0,
          body: {
            success: false,
            message: error.message
          }
        };
      });
  },

  // GET /reports/mine?email=... -> SELECT reports belonging to the signed-in student.
  getMyReports: function (email) {
    var url =
      AWS_API_BASE +
      "/reports/mine?email=" +
      encodeURIComponent(email || "");

    return fetch(url, {
      method: "GET",
      cache: "no-store", //helps make the request retrieve fresh data.
      headers: getNexSafeApiHeaders()
    })
      .then(readApiResponse)
      .then(function (result) {
        if (!result.ok) {
          return {
            statusCode: result.statusCode,
            body: result.data
          };
        }

        var apiReports =
          result.data && Array.isArray(result.data.reports)
            ? result.data.reports
            : [];

        var myReports =
          apiReports.map(normalizeApiReport);

        return {
          statusCode: result.statusCode,
          body: myReports
        };
      })
      .catch(function (error) {
        console.error("AWS my reports error:", error);

        return {
          statusCode: 0,
          body: {
            success: false,
            message: error.message
          }
        };
      });
  },

  // GET /reports/{id} -> SELECT one report.
  getReport: function (reportId) {
    return fetch(
      AWS_API_BASE +
        "/reports/" +
        encodeURIComponent(reportId),
      {
        method: "GET",
        cache: "no-store",
        headers: getNexSafeApiHeaders()
      }
    )
      .then(readApiResponse)
      .then(function (result) {
        if (!result.ok) {
          return {
            statusCode: result.statusCode,
            body: result.data
          };
        }

        return {
          statusCode: result.statusCode,
          body: normalizeApiReport(
            result.data ? result.data.report : null
          )
        };
      })
      .catch(function (error) {
        console.error("AWS get report error:", error);

        return {
          statusCode: 0,
          body: {
            success: false,
            message: error.message
          }
        };
      });
  },

  // POST /reports -> INSERT a real report into RDS.
  createReport: function (payload) {
    var outgoing = Object.assign({}, payload || {});

    // Never trust an old/hardcoded author value from a page script.
    // The report always belongs to the currently authenticated Cognito user.
    if (currentUser) {
      outgoing.author_id = currentUser.email;
      outgoing.author_name = currentUser.name;
      outgoing.authorId = currentUser.email;
      outgoing.authorName = currentUser.name;
    }

    return fetch(AWS_API_BASE + "/reports", {
      method: "POST",
      headers: getNexSafeApiHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(outgoing)
    })
      .then(readApiResponse)
      .then(function (result) {
        console.log(
          "NexSafe POST /reports HTTP result:",
          result
        );

        if (!result.ok) {
          return {
            statusCode: result.statusCode,
            body: result.data
          };
        }

        var newReport =
          normalizeApiReport(
            result.data ? result.data.report : null
          );

        if (newReport) {
          reports.unshift(newReport);
        }

        return {
          statusCode: result.statusCode,
          body: newReport
        };
      })
      .catch(function (error) {
        console.error("AWS create report error:", error);

        return {
          statusCode: 0,
          body: {
            success: false,
            message: error.message
          }
        };
      });
  },

  // PUT /reports/{id} -> UPDATE only the supplied fields in RDS.
  updateReport: function (reportId, updates) {
    console.log(
      "NexSafe PUT report:",
      reportId,
      updates
    );

    return fetch(
      AWS_API_BASE +
        "/reports/" +
        encodeURIComponent(reportId),
      {
        method: "PUT",
        cache: "no-store",
        headers: getNexSafeApiHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify(updates || {})
      }
    )
      .then(readApiResponse)
      .then(function (result) {
        if (!result.ok) {
          return {
            statusCode: result.statusCode,
            body: result.data
          };
        }

        var updatedReport =
          normalizeApiReport(
            result.data ? result.data.report : null
          );

        if (updatedReport) {
          for (var i = 0; i < reports.length; i++) {
            if (String(reports[i].id) === String(updatedReport.id)) {
              reports[i] = updatedReport;
              break;
            }
          }
        }

        console.log(
          "NexSafe PUT saved in RDS:",
          updatedReport
        );

        return {
          statusCode: result.statusCode,
          body: updatedReport
        };
      })
      .catch(function (error) {
        console.error("AWS update report error:", error);

        return {
          statusCode: 0,
          body: {
            success: false,
            message: error.message
          }
        };
      });
  },

  // POST /analyze-image
  // Browser Base64 -> Lambda -> S3 -> Rekognition Custom Labels.
  //
  // options.imageKey:
  //   If the image was already uploaded during an earlier verification,
  //   reuse the same S3 object rather than creating a duplicate.
  //
  // options.uploadOnly:
  //   Used for "Other" reports. The image is still saved to S3, but
  //   Rekognition classification is skipped and staff review it manually.
  analyzeImage: function (imageData, selectedValue, options) {
    options = options || {};

    var requestBody = {
      imageKey: options.imageKey || null,
      uploadOnly: !!options.uploadOnly,
      fileName: options.fileName || null
    };

    // Only send the Base64 bytes when the photo has not already been
    // uploaded. This avoids repeatedly sending a large image when the
    // student changes the issue-type dropdown.
    if (!requestBody.imageKey) {
      var imageString = String(imageData || "");
      var dataUrlMatch = imageString.match(
        /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/is
      );

      if (dataUrlMatch) {
        requestBody.contentType =
          dataUrlMatch[1].toLowerCase() === "image/jpg"
            ? "image/jpeg"
            : dataUrlMatch[1].toLowerCase();

        requestBody.imageBase64 =
          dataUrlMatch[2].replace(/\s/g, "");
      } else {
        // Also supports the raw Base64 format used by the lab example.
        requestBody.imageBase64 = imageString;
        requestBody.contentType =
          options.contentType || "image/jpeg";
      }
    }

    return fetch(AWS_API_BASE + "/analyze-image", {
      method: "POST",
      headers: getNexSafeApiHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(requestBody)
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {

            if (!response.ok) {
              return {
                statusCode: response.status,
                body: data
              };
            }

            // uploadOnly is for "Other". The backend still returns
            // imageKey/imageUrl, but there is intentionally no AI label.
            if (requestBody.uploadOnly) {
              data.labels = [];
              data.predicted_issue_type = null;
              data.predicted_category = null;
              data.matched = false;

              return {
                statusCode: response.status,
                body: data
              };
            }

            var rawLabel =
              (data.label || "").toLowerCase();

            // Exact mapping between the five trained model classes and
            // the issue types available in the NexSafe form.
            var modelLabels = {
              electrical: {
                display: "Electrical Issue",
                category: "Safety Hazards"
              },
              staircase: {
                display: "Staircase Issue",
                category: "Safety Hazards"
              },
              water: {
                display: "Water Issue",
                category: "Safety Hazards"
              },
              chair: {
                display: "Broken Chair",
                category: "Maintenance Issues"
              },
              desk: {
                display: "Broken Table or Desk",
                category: "Maintenance Issues"
              }
            };

            var prediction =
              modelLabels[rawLabel];

            if (!data.detected || !prediction) {
              data.labels = [
                data.label ||
                "No supported issue detected"
              ];
              data.predicted_issue_type =
                data.label || null;
              data.predicted_category = null;
              data.matched = false;

              return {
                statusCode: response.status,
                body: data
              };
            }

            data.labels = [
              prediction.display
            ];
            data.predicted_issue_type =
              prediction.display;
            data.predicted_category =
              prediction.category;

            data.matched =
              selectedValue === prediction.display ||
              selectedValue === prediction.category;

            return {
              statusCode: response.status,
              body: data
            };
          });
      })
      .catch(function (error) {
        console.error(
          "AWS image upload/analysis error:",
          error
        );

        return {
          statusCode: 0,
          body: {
            success: false,
            message: error.message
          }
        };
      });
  },

  // DELETE /reports/{id} -> DELETE the real RDS row.
  deleteReport: function (id) {
    return fetch(
      AWS_API_BASE +
        "/reports/" +
        encodeURIComponent(id),
      {
        method: "DELETE",
        headers: getNexSafeApiHeaders()
      }
    )
      .then(readApiResponse)
      .then(function (result) {
        if (!result.ok) {
          return {
            statusCode: result.statusCode,
            body: result.data
          };
        }

        reports = reports.filter(function (report) {
          return String(report.id) !== String(id);
        });

        return {
          statusCode: result.statusCode,
          body: result.data
        };
      })
      .catch(function (error) {
        console.error("AWS delete report error:", error);

        return {
          statusCode: 0,
          body: {
            success: false,
            message: error.message
          }
        };
      });
  }
};

/* =========================================================
   State restoration
   Authentication now comes from the stored Cognito ID token.
   Reports still come from RDS through awsApi.
   ========================================================= */
function loadState() {
  reports = [];

  currentUser =
    getCognitoUserFromStoredSession();

  if (currentUser) {
    localStorage.setItem(
      "nexsafe_user",
      JSON.stringify(currentUser)
    );
  } else {
    // Prevent an old/fake localStorage user from bypassing Cognito.
    localStorage.removeItem("nexsafe_user");
  }
}

/* Kept only for backwards compatibility with any older page script.
   Report persistence is now handled by RDS, so this intentionally does nothing. */
function saveReports() {
  return;
}

/* Legacy mock-auth helpers kept only so an old page cannot crash.
   Real authentication is now handled by Amazon Cognito. */
function getAccounts() {
  return {};
}

function saveAccounts() {
  return;
}

/*
   AUTH GUARDS
   Every page under the signed-in app calls one of these
   before setting itself up. Since each page is now a real
   HTML file, we can no longer just hide/show a screen — we
   redirect to the right page instead.
   
   */
function requireAuth() {
  if (!currentUser) {
    window.location.href = "auth.html";
    return false;
  }
  return true;
}

function requireRole(role) {
  if (!requireAuth()) return false;
  if (currentUser.role !== role) {
    window.location.href = "home.html";
    return false;
  }
  return true;
}

/* 
   FLASH MESSAGE
   A toast that needs to appear right as we redirect to a new
   page (e.g. "Signed out.") would never be seen if we just
   called showToast() and immediately navigated away — the
   page unloads before the animation plays. Instead we stash
   the message in sessionStorage, redirect, and the next page
   shows it on load via showFlashMessageIfAny().
    */
function setFlashMessage(msg, type) {
  sessionStorage.setItem("nexsafe_flash", JSON.stringify({ msg: msg, type: type }));
}
//Stores a temporary message before redirecting.
function showFlashMessageIfAny() {
  var raw = sessionStorage.getItem("nexsafe_flash");
  if (!raw) return;
  sessionStorage.removeItem("nexsafe_flash");
  try {
    var flash = JSON.parse(raw);
    showToast(flash.msg, flash.type);
  } catch (e) {}
}//Session Storage is temporary browser storage that keeps data only while the current browser tab is open. The data is automatically
// deleted when the tab or browser is closed.

/*  Toast */
var toast = $("#toast");
var toastMsg = $("#toastMsg");
var toastIcon = $("#toastIcon");
var toastTimer;

function showToast(msg, type) {
  toastMsg.textContent = msg;
  toastIcon.style.background = type === "error" ? "var(--c-error)" : "var(--c-success)";
  toast.classList.add("is-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove("is-show"); }, 3500);
}

// Back to top  
var toTop = $("#toTop");
window.addEventListener("scroll", function () {
  toTop.classList.toggle("is-show", window.scrollY > 600);
}, { passive: true });
toTop.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });

/* 
   SHARED HELPERS (used by whichever page renders report cards
   or the report detail modal)
    */
var statusMap = {
  submitted: { label: "Submitted", class: "submitted" },
  in_review: { label: "Under Review", class: "review" },
  in_progress: { label: "In Progress", class: "progress" },
  resolved: { label: "Resolved", class: "resolved" },
  rejected: { label: "Rejected", class: "rejected" },
};

var priorityMap = {
  low: { label: "Low priority", class: "low" },
  medium: { label: "Medium priority", class: "medium" },
  high: { label: "High priority", class: "high" },
};

function tagClass(cat) {
  var map = { "Safety Hazards": "tag--danger", "Maintenance Issues": "tag--warn", "Other": "tag--info" };
  return map[cat] || "tag--info";
}

function timeAgo(dateStr) {
  var diff = Date.now() - new Date(dateStr).getTime();
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  var days = Math.floor(hrs / 24);
  return days + "d ago";
}//Changes timestamps into readable text

function escapeHtml(str) {
  var div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}//Prevents user-entered text from being interpreted as HTML
// ---------------------------------------------------------
// Split normal location text from Amazon Location coordinates.
//
// Example stored in RDS:
// Engineering Block, 3, Room 2 | Map: 1.345201, 103.931654
// ---------------------------------------------------------
function parseNexSafeLocation(location) {
  var value = String(location || "");

  var marker = " | Map:";
  var markerIndex = value.indexOf(marker);

  // Old reports without map coordinates still work normally.
  if (markerIndex === -1) {
    return {
      text: value,
      latitude: null,
      longitude: null
    };
  }

  var normalLocation =
    value.substring(0, markerIndex).trim();

  var coordinateText =
    value.substring(markerIndex + marker.length).trim();

  var coordinateParts =
    coordinateText.split(",");

  var latitude =
    parseFloat(coordinateParts[0]);

  var longitude =
    parseFloat(coordinateParts[1]);

  if (
    isNaN(latitude) ||
    isNaN(longitude)
  ) {
    return {
      text: normalLocation,
      latitude: null,
      longitude: null
    };
  }

  return {
    text: normalLocation,
    latitude: latitude,
    longitude: longitude
  };
}
function createReportCard(r, i) {
  var card = document.createElement("article");
  card.className = "feedcard";
  card.style.animationDelay = (i * 50) + "ms";
  var s = statusMap[r.status] || statusMap.submitted;
  var p = priorityMap[r.priority] || null;

  // Below we build up ONE big HTML string using + and drop it into the
  // card in one go with .innerHTML. The bits like (r.image ? '...' : '')
  // are a shorthand "if/else": if r.image has a value, use the HTML on
  // the left of the ":", otherwise use an empty string (skip it).
  card.innerHTML =
    (r.image ? '<div class="feedcard__photo" style="background-image:url(\'' + r.image + '\')"></div>' : '') +
    '<div class="feedcard__top">' +
      '<span class="tag ' + tagClass(r.category) + '">' + r.category + '</span>' +
      (p ? '<span class="priority-dot priority-dot--' + p.class + '" title="' + p.label + '"></span>' : '') +
    '</div>' +
    (r.issue_type ? '<p class="feedcard__issuetype">' + escapeHtml(r.issue_type) + '</p>' : '') +
    '<h3 class="feedcard__title">' + escapeHtml(r.title) + '</h3>' +
    '<p class="feedcard__loc">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 21s-7-5.5-7-11a7 7 0 0114 0c0 5.5-7 11-7 11z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" stroke-width="2"/></svg>' +
      escapeHtml(parseNexSafeLocation(r.location).text) +
    '</p>' +
    '<div class="feedcard__foot">' +
      '<span class="feedcard__status feedcard__status--' + s.class + '">' + s.label + '</span>' +
      '<span class="feedcard__posted">Posted ' + timeAgo(r.created_at) + '</span>' +
    '</div>';

  card.addEventListener("click", function () {
    openReportModal(r);
  });

  return card;
}


/* =========================================================
   IN-APP NAVBAR NOTIFICATIONS
   =========================================================
   Staff: new student reports.
   Students: status changes + staff updates on their own reports.
*/
var nexsafeNotificationItems = [];
var nexsafeNotificationTimer = null;
var nexsafeNotificationBusy = false;

function nexsafeNotificationReadKey() {
  if (!currentUser) return "nexsafe_notif_read_guest";

  return [
    "nexsafe_notif_read",
    currentUser.role || "user",
    currentUser.email || "unknown"
  ].join(":");
}

function getNexSafeReadNotifications() {
  try {
    var saved = JSON.parse(
      localStorage.getItem(
        nexsafeNotificationReadKey()
      ) || "[]"
    );

    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    return [];
  }
}

function saveNexSafeReadNotifications(ids) {
  localStorage.setItem(
    nexsafeNotificationReadKey(),
    JSON.stringify(
      Array.from(new Set(ids || []))
        .slice(-200)
    )
  );
}

function nexsafeNotificationIdForReport(report) {
  if (!currentUser || !report) return "";

  if (currentUser.role === "staff") {
    return "staff:new:" + String(report.id);
  }

  return [
    "student:update",
    String(report.id),
    String(
      report.updated_at ||
      report.status ||
      report.created_at ||
      ""
    )
  ].join(":");
}

function nexsafeBuildNotificationItems(reportList) {
  var list = Array.isArray(reportList)
    ? reportList.slice()
    : [];

  if (!currentUser) return [];

  if (currentUser.role === "staff") {
    return list
      .sort(function (a, b) {
        return (
          new Date(b.created_at || 0).getTime() -
          new Date(a.created_at || 0).getTime()
        );
      })
      .slice(0, 10)
      .map(function (report) {
        return {
          id: nexsafeNotificationIdForReport(report),
          report: report,
          title: "New report submitted",
          text:
            '"' +
            (report.title || "Untitled report") +
            '"',
          meta:
            (report.author_name || "Student") +
            " • " +
            timeAgo(report.created_at)
        };
      });
  }

  return list
    .filter(function (report) {
      return (
        report.status !== "submitted" ||
        !!report.staff_update
      );
    })
    .sort(function (a, b) {
      return (
        new Date(
          b.updated_at ||
          b.created_at ||
          0
        ).getTime() -
        new Date(
          a.updated_at ||
          a.created_at ||
          0
        ).getTime()
      );
    })
    .slice(0, 10)
    .map(function (report) {
      var statusInfo =
        statusMap[report.status] ||
        statusMap.submitted;

      var text =
        'Your report "' +
        (report.title || "Untitled report") +
        '" is now ' +
        statusInfo.label +
        ".";

      if (report.staff_update) {
        text +=
          " Staff update: " +
          report.staff_update;
      }

      return {
        id: nexsafeNotificationIdForReport(report),
        report: report,
        title: "Report updated",
        text: text,
        meta: timeAgo(
          report.updated_at ||
          report.created_at
        )
      };
    });
}

function nexsafeEnsureNotificationStyles() {
  if (
    document.getElementById(
      "nexsafeNotificationStyles"
    )
  ) return;

  var style = document.createElement("style");
  style.id = "nexsafeNotificationStyles";

  style.textContent = `
    .nexsafe-notif-wrap {
      position: relative;
      display: flex;
      align-items: center;
      flex: 0 0 auto;
    }

    .nexsafe-notif-btn {
      position: relative;
      width: 40px;
      height: 40px;
      border: 1px solid #e2e8f0;
      border-radius: 50%;
      background: #fff;
      color: #475569;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: .18s ease;
    }

    .nexsafe-notif-btn:hover {
      background: #f0fdfa;
      border-color: #99f6e4;
      color: #0f766e;
      transform: translateY(-1px);
    }

    .nexsafe-notif-btn:focus-visible {
      outline: 3px solid rgba(20,184,166,.18);
      outline-offset: 2px;
    }

    .nexsafe-notif-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 999px;
      background: #ef4444;
      color: #fff;
      border: 2px solid #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 800;
      line-height: 1;
      box-sizing: border-box;
    }

    .nexsafe-notif-panel {
      position: absolute;
      top: calc(100% + 12px);
      right: 0;
      width: min(360px, calc(100vw - 24px));
      max-height: 440px;
      overflow: hidden;
      z-index: 10050;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 18px;
      box-shadow:
        0 20px 50px rgba(15,23,42,.16),
        0 4px 14px rgba(15,23,42,.08);
    }

    .nexsafe-notif-head {
      padding: 15px 16px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #eef2f7;
    }

    .nexsafe-notif-head strong {
      display: block;
      color: #0f172a;
      font-size: .96rem;
      line-height: 1.2;
    }

    .nexsafe-notif-head span {
      display: block;
      margin-top: 3px;
      color: #94a3b8;
      font-size: .74rem;
    }

    .nexsafe-notif-refresh {
      border: 0;
      background: transparent;
      color: #0f766e;
      font: inherit;
      font-size: .74rem;
      font-weight: 700;
      cursor: pointer;
      padding: 5px 0;
    }

    .nexsafe-notif-list {
      max-height: 365px;
      overflow-y: auto;
    }

    .nexsafe-notif-item {
      width: 100%;
      border: 0;
      border-bottom: 1px solid #f1f5f9;
      background: #fff;
      padding: 13px 15px;
      text-align: left;
      display: grid;
      grid-template-columns: 9px minmax(0,1fr);
      gap: 10px;
      cursor: pointer;
      font: inherit;
    }

    .nexsafe-notif-item:hover {
      background: #f8fafc;
    }

    .nexsafe-notif-item.is-unread {
      background: #f0fdfa;
    }

    .nexsafe-notif-item.is-unread:hover {
      background: #e6fffb;
    }

    .nexsafe-notif-dot {
      width: 8px;
      height: 8px;
      margin-top: 5px;
      border-radius: 50%;
      background: #14b8a6;
    }

    .nexsafe-notif-item:not(.is-unread)
      .nexsafe-notif-dot {
      background: transparent;
    }

    .nexsafe-notif-title {
      display: block;
      color: #0f172a;
      font-size: .82rem;
      font-weight: 750;
      margin-bottom: 3px;
    }

    .nexsafe-notif-text {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      color: #475569;
      font-size: .79rem;
      line-height: 1.45;
    }

    .nexsafe-notif-meta {
      display: block;
      margin-top: 6px;
      color: #94a3b8;
      font-size: .70rem;
    }

    .nexsafe-notif-empty {
      padding: 28px 20px;
      color: #64748b;
      text-align: center;
      font-size: .82rem;
      line-height: 1.5;
    }

    @media (max-width: 760px) {
      .nexsafe-notif-btn {
        width: 36px;
        height: 36px;
      }

      .nexsafe-notif-panel {
        position: fixed;
        top: 76px;
        right: 12px;
        left: 12px;
        width: auto;
        max-height: min(70vh, 440px);
      }
    }
  `;

  document.head.appendChild(style);
}

function nexsafeEnsureNotificationBell() {
  if (!currentUser) return null;

  nexsafeEnsureNotificationStyles();

  var existing =
    document.getElementById(
      "nexsafeNotificationWrap"
    );

  if (existing) return existing;

  var actions =
    document.querySelector(
      ".header__actions"
    );

  if (!actions) return null;

  var wrap = document.createElement("div");
  wrap.id = "nexsafeNotificationWrap";
  wrap.className = "nexsafe-notif-wrap";

  wrap.innerHTML = `
    <button
      type="button"
      class="nexsafe-notif-btn"
      id="nexsafeNotificationBtn"
      aria-label="Notifications"
      aria-haspopup="true"
      aria-expanded="false">
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true">
        <path
          d="M18 8a6 6 0 10-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-linejoin="round"/>
        <path
          d="M10 21h4"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"/>
      </svg>
      <span
        class="nexsafe-notif-badge"
        id="nexsafeNotificationBadge"
        hidden>0</span>
    </button>

    <div
      class="nexsafe-notif-panel"
      id="nexsafeNotificationPanel"
      hidden>
      <div class="nexsafe-notif-head">
        <div>
          <strong>Notifications</strong>
          <span id="nexsafeNotificationSub">
            Latest NexSafe activity
          </span>
        </div>
        <button
          type="button"
          class="nexsafe-notif-refresh"
          id="nexsafeNotificationRefresh">
          Refresh
        </button>
      </div>
      <div
        class="nexsafe-notif-list"
        id="nexsafeNotificationList">
        <div class="nexsafe-notif-empty">
          Loading notifications…
        </div>
      </div>
    </div>
  `;

  var userWrap =
    actions.querySelector(
      ".userchip-wrap"
    );

  if (userWrap) {
    actions.insertBefore(wrap, userWrap);
  } else {
    actions.insertBefore(
      wrap,
      actions.firstChild
    );
  }

  var button =
    document.getElementById(
      "nexsafeNotificationBtn"
    );

  var panel =
    document.getElementById(
      "nexsafeNotificationPanel"
    );

  button.addEventListener(
    "click",
    function (event) {
      event.stopPropagation();

      var opening = panel.hidden;

      if (opening) {
        if (
          typeof toggleProfileMenu ===
          "function"
        ) {
          toggleProfileMenu(false);
        }

        panel.hidden = false;
        button.setAttribute(
          "aria-expanded",
          "true"
        );

        nexsafeMarkVisibleNotificationsRead();
      } else {
        panel.hidden = true;
        button.setAttribute(
          "aria-expanded",
          "false"
        );
      }
    }
  );

  document
    .getElementById(
      "nexsafeNotificationRefresh"
    )
    .addEventListener(
      "click",
      function (event) {
        event.stopPropagation();
        refreshNexSafeNotificationBell();
      }
    );

  document.addEventListener(
    "click",
    function (event) {
      if (
        !panel.hidden &&
        !wrap.contains(event.target)
      ) {
        panel.hidden = true;
        button.setAttribute(
          "aria-expanded",
          "false"
        );
      }
    }
  );

  document.addEventListener(
    "keydown",
    function (event) {
      if (
        event.key === "Escape" &&
        !panel.hidden
      ) {
        panel.hidden = true;
        button.setAttribute(
          "aria-expanded",
          "false"
        );
      }
    }
  );

  return wrap;
}

function nexsafeMarkVisibleNotificationsRead() {
  var readIds =
    getNexSafeReadNotifications();

  nexsafeNotificationItems
    .forEach(function (item) {
      if (
        item.id &&
        !readIds.includes(item.id)
      ) {
        readIds.push(item.id);
      }
    });

  saveNexSafeReadNotifications(readIds);
  nexsafeRenderNotificationBell();
}

function nexsafeOpenNotification(item) {
  if (!item || !item.report) return;

  var panel =
    document.getElementById(
      "nexsafeNotificationPanel"
    );

  if (panel) panel.hidden = true;

  var button =
    document.getElementById(
      "nexsafeNotificationBtn"
    );

  if (button) {
    button.setAttribute(
      "aria-expanded",
      "false"
    );
  }

  if (
    typeof modal !== "undefined" &&
    modal &&
    typeof modalBody !== "undefined" &&
    modalBody &&
    typeof openReportModal === "function"
  ) {
    openReportModal(item.report);
    return;
  }

  window.location.href =
    currentUser.role === "staff"
      ? "manage.html"
      : "myreports.html";
}

function nexsafeRenderNotificationBell() {
  var badge =
    document.getElementById(
      "nexsafeNotificationBadge"
    );

  var list =
    document.getElementById(
      "nexsafeNotificationList"
    );

  var sub =
    document.getElementById(
      "nexsafeNotificationSub"
    );

  if (!badge || !list) return;

  var readIds =
    getNexSafeReadNotifications();

  var unread =
    nexsafeNotificationItems
      .filter(function (item) {
        return (
          item.id &&
          !readIds.includes(item.id)
        );
      });

  if (unread.length > 0) {
    badge.hidden = false;
    badge.textContent =
      unread.length > 99
        ? "99+"
        : String(unread.length);
  } else {
    badge.hidden = true;
    badge.textContent = "0";
  }

  if (sub) {
    sub.textContent =
      currentUser.role === "staff"
        ? "New student reports"
        : "Status & staff updates";
  }

  if (
    nexsafeNotificationItems.length ===
    0
  ) {
    list.innerHTML =
      '<div class="nexsafe-notif-empty">' +
        'No notifications yet.' +
      '</div>';
    return;
  }

  list.innerHTML = "";

  nexsafeNotificationItems
    .forEach(function (item) {
      var unreadItem =
        item.id &&
        !readIds.includes(item.id);

      var row =
        document.createElement("button");

      row.type = "button";
      row.className =
        "nexsafe-notif-item" +
        (unreadItem
          ? " is-unread"
          : "");

      row.innerHTML =
        '<span class="nexsafe-notif-dot"></span>' +
        '<span>' +
          '<span class="nexsafe-notif-title">' +
            escapeHtml(item.title) +
          '</span>' +
          '<span class="nexsafe-notif-text">' +
            escapeHtml(item.text) +
          '</span>' +
          '<span class="nexsafe-notif-meta">' +
            escapeHtml(item.meta || "") +
          '</span>' +
        '</span>';

      row.addEventListener(
        "click",
        function () {
          var ids =
            getNexSafeReadNotifications();

          if (
            item.id &&
            !ids.includes(item.id)
          ) {
            ids.push(item.id);
            saveNexSafeReadNotifications(ids);
          }

          nexsafeRenderNotificationBell();
          nexsafeOpenNotification(item);
        }
      );

      list.appendChild(row);
    });
}

function refreshNexSafeNotificationBell() {
  if (
    !currentUser ||
    nexsafeNotificationBusy
  ) {
    return Promise.resolve();
  }

  nexsafeEnsureNotificationBell();
  nexsafeNotificationBusy = true;

  var request =
    currentUser.role === "staff"
      ? awsApi.listReports()
      : awsApi.getMyReports(
          currentUser.email
        );

  return request
    .then(function (response) {
      if (
        response.statusCode !== 200 ||
        !Array.isArray(response.body)
      ) {
        return;
      }

      nexsafeNotificationItems =
        nexsafeBuildNotificationItems(
          response.body
        );

      nexsafeRenderNotificationBell();
    })
    .catch(function (error) {
      console.warn(
        "NexSafe notification refresh failed:",
        error
      );
    })
    .finally(function () {
      nexsafeNotificationBusy = false;
    });
}

function setupNotificationBell() {
  if (!currentUser) return;

  nexsafeEnsureNotificationBell();
  refreshNexSafeNotificationBell();

  if (!nexsafeNotificationTimer) {
    nexsafeNotificationTimer =
      window.setInterval(
        function () {
          if (!document.hidden) {
            refreshNexSafeNotificationBell();
          }
        },
        20000
      );
  }
}


/* Only present on home/feed/report/myreports/review/manage —
every element below is guarded so this file can be safely
loaded */
function setupAppUI() {
  if (!currentUser) return;
  var name = currentUser.name;
  var email = currentUser.email;
  var role = currentUser.role;
  // Turns a full name into up to 2 uppercase initials for the avatar
  // circle, e.g. "Alex Tan" -> "AT". Step by step: .split(" ") breaks the
  // name into words ["Alex","Tan"], .map(...) grabs just the first letter
  // of each word ["A","T"], .slice(0,2) keeps only the first 2 letters
  // (in case someone has a long name), and .join("") glues them back
  // into one string "AT".
  var initials = name.split(" ").map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase();

  if ($("#userName")) $("#userName").textContent = name;
  if ($("#userRole")) $("#userRole").textContent = role;
  if ($("#userAvatar")) $("#userAvatar").textContent = initials;

  if ($("#profileAvatar")) $("#profileAvatar").textContent = initials;
  if ($("#profileName")) $("#profileName").textContent = name;
  if ($("#profileEmail")) $("#profileEmail").textContent = email;
  if ($("#profileRole")) $("#profileRole").textContent = role === "staff" ? "Staff" : "Student";

  // Any element with data-role="student"/"staff" gets hidden for the
  // other role — not just nav links, so role-gated buttons like feed.html's
  // "New report" CTA are covered too.
  $$("[data-role]").forEach(function (el) {
    var elRole = el.dataset.role;
    el.style.display = (!elRole || elRole === role) ? "" : "none";
  });

  setupNotificationBell();
}

/*  Profile dropdown  */
var userChip = $("#userChip");
var profileMenu = $("#profileMenu");

function toggleProfileMenu(open) {
  if (!userChip || !profileMenu) return;
  var next = open !== undefined ? open : profileMenu.hidden;
  profileMenu.hidden = !next;
  userChip.setAttribute("aria-expanded", String(next));
}

if (userChip && profileMenu) {
  userChip.addEventListener("click", function (e) {
    e.stopPropagation();
    toggleProfileMenu();
  });
  document.addEventListener("click", function (e) {
    if (!profileMenu.hidden && !profileMenu.contains(e.target) && e.target !== userChip) {
      toggleProfileMenu(false);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !profileMenu.hidden) toggleProfileMenu(false);
  });
}

/* Sign out through Amazon Cognito, then clear the local browser session. */
var signOutBtn = $("#signOutBtn");

if (signOutBtn) {
  signOutBtn.addEventListener("click", function () {
    var accessToken =
      localStorage.getItem(
        "nexsafe_cognito_access_token"
      );

    signOutBtn.disabled = true;

    cognitoGlobalSignOut(accessToken)
      .catch(function (error) {
        console.warn(
          "Cognito sign-out request failed:",
          error
        );
      })
      .finally(function () {
        clearStoredCognitoSession();
        setFlashMessage("Signed out.");
        window.location.href = "index.html";
      });
  });
}

/*  Mobile nav toggle  */
var appNavToggle = $("#appNavToggle");
var appNav = $("#appNav");
function closeAppNav(open) {
  //Controls the mobile navigation menu.
  if (!appNavToggle || !appNav) return;
  var next = open !== undefined ? open : false;
  appNav.classList.toggle("is-open", next);
  appNavToggle.classList.toggle("is-open", next);
  appNavToggle.setAttribute("aria-expanded", String(next));
}
if (appNavToggle && appNav) {
  appNavToggle.addEventListener("click", function () {
    closeAppNav(!appNav.classList.contains("is-open"));
  });
}

/* REPORT DETAIL MODAL
Present on feed/home/myreports/review/manage — every report
card on those pages opens this same modal */
var modal = $("#reportModal");
var modalBody = $("#modalBody");
var currentModalReport = null;

/* Build the <option> list for the status dropdown, e.g.
   <option value="submitted">Submitted</option><option value="in_review">In review</option>... */
function buildStatusOptionsHtml(selectedStatus) {
  var statusOrder = ["submitted", "in_review", "in_progress", "resolved", "rejected"];
  var html = "";
  for (var i = 0; i < statusOrder.length; i++) {
    var st = statusOrder[i];
    var label = statusMap[st].label;
    var selected = "";
    if (st === selectedStatus) selected = " selected";
    html += '<option value="' + st + '"' + selected + '>' + label + '</option>';
  }
  return html;
}

/* Same idea for the priority dropdown, plus a "Not set" option at the top. */
function buildPriorityOptionsHtml(selectedPriority) {
  var priorityOrder = ["low", "medium", "high"];
  var html = '<option value="">Not set</option>';
  for (var i = 0; i < priorityOrder.length; i++) {
    var pr = priorityOrder[i];
    var label = priorityMap[pr].label;
    var selected = "";
    if (pr === selectedPriority) selected = " selected";
    html += '<option value="' + pr + '"' + selected + '>' + label + '</option>';
  }
  return html;
}
//Displays full report information.
function openReportModal(report) {
  currentModalReport = report;
  var s = statusMap[report.status] || statusMap.submitted;
  var p = priorityMap[report.priority] || null;
  var isStaff = currentUser && currentUser.role === "staff";
  // Separate readable location from AWS map coordinates.
  var locationInfo =
    parseNexSafeLocation(report.location);

  // Only staff need the interactive map.
  var canShowAdminMap =
    isStaff &&
    locationInfo.latitude !== null &&
    locationInfo.longitude !== null &&
    typeof maplibregl !== "undefined" &&
    window.NEXSAFE_LOCATION_API_KEY;

  // Photo + simulated Rekognition result (only shown if a photo was attached)
  var photoHtml = "";
  if (report.image) {
    photoHtml = '<img class="modal__photo" src="' + report.image + '" alt="Report photo" />';
    if (report.rekognition) {
      var scanClass = "mismatch";
      var scanIcon = "⚠";

      if (report.rekognition.matched) {
        scanClass = "match";
        scanIcon = "✓";
      }

      var detectedText =
        report.rekognition.predicted_issue_type ||
        (Array.isArray(report.rekognition.labels)
          ? report.rekognition.labels.join(", ")
          : (report.rekognition.label || "No supported issue detected"));

      photoHtml += '<p class="modal__scan modal__scan--' + scanClass + '">' +
        scanIcon + ' AWS Rekognition: detected ' +
        escapeHtml(detectedText) +
        ' — ' + (report.rekognition.confidence ?? 0) + '% confidence</p>';
    }
  }

  // Status: staff get a dropdown, everyone else sees a read-only badge
  var statusHtml;
  if (isStaff) {
    statusHtml = '<select class="status-select" id="statusSelect">' + buildStatusOptionsHtml(report.status) + '</select>';
  } else {
    statusHtml = '<span class="feedcard__status feedcard__status--' + s.class + '">' + s.label + '</span>';
  }

  // Priority: staff get a dropdown; students see a badge (or "not yet prioritised")
  var priorityHtml;
  if (isStaff) {
    priorityHtml = '<select class="status-select" id="prioritySelect">' + buildPriorityOptionsHtml(report.priority) + '</select>';
  } else if (p) {
    priorityHtml = '<span class="priority-badge priority-badge--' + p.class + '">' + p.label + '</span>';
  } else {
    priorityHtml = '<span class="priority-badge priority-badge--none">Not yet prioritised</span>';
  }

  var deleteZoneHtml = "";
  if (isStaff) {
    deleteZoneHtml = '<div class="modal__danger" id="modalDanger">' +
      '<button type="button" class="btn-link btn-link--danger" id="deleteReportBtn">Delete this report</button>' +
    '</div>';
  }

  // Staff update: staff get a textarea + save button; students see the
  // saved message read-only (or nothing, if staff hasn't written one yet).
  var staffUpdateHtml = "";
  if (isStaff) {
    staffUpdateHtml =
      '<div class="staff-update">' +
        '<label class="staff-update__title" for="staffUpdateInput">Staff update</label>' +
        '<p class="staff-update__hint">This message will be visible to the student who submitted the report.</p>' +
        '<textarea id="staffUpdateInput" maxlength="500" placeholder="Explain what action has been taken…">' +
          escapeHtml(report.staff_update || "") +
        '</textarea>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="saveStaffUpdateBtn">Save update</button>' +
      '</div>';
    } else if (report.staff_update) {
      staffUpdateHtml =
        '<div class="staff-update staff-update--readonly">' +
          '<p class="staff-update__title">Staff update</p>' +
          '<p class="staff-update__text">' + escapeHtml(report.staff_update) + '</p>' +
        '</div>';
    }
  
    // Create an Amazon Location map section for staff.
    var adminMapHtml = "";
  
    if (canShowAdminMap) {
      adminMapHtml =
        '<div class="admin-location">' +
          '<p class="admin-location__title">📍 Pinned issue location</p>' +
          '<p class="admin-location__hint">' +
            'Location selected by the student when submitting this report.' +
          '</p>' +
          '<div id="adminLocationMap"></div>' +
        '</div>';
    }
  
    modalBody.innerHTML =
      photoHtml +
      '<span class="tag ' + tagClass(report.category) + ' modal__cat">' + report.category + '</span>' +
    (report.issue_type ? '<p class="modal__issuetype">Issue type: <strong>' + escapeHtml(report.issue_type) + '</strong></p>' : '') +
    '<h2 class="modal__title">' + escapeHtml(report.title) + '</h2>' +
    '<p class="modal__loc"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 21s-7-5.5-7-11a7 7 0 0114 0c0 5.5-7 11-7 11z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" stroke-width="2"/></svg> ' + escapeHtml(locationInfo.text) + '</p>' +adminMapHtml +
    '<p class="modal__desc">' + escapeHtml(report.description) + '</p>' +
    '<p class="modal__posted">Posted ' + timeAgo(report.created_at) + '</p>' +
    '<div class="modal__statusrow">' +
      '<span class="modal__status-label">Status:</span>' +
      statusHtml +
      '<span class="modal__status-label">Priority:</span>' +
      priorityHtml +
    '</div>' +
    staffUpdateHtml +
    deleteZoneHtml;

    modal.hidden = false;

    // -------------------------------------------------------
    // Show student's pinned Amazon Location to staff.
    // -------------------------------------------------------
    if (window.nexsafeAdminLocationMap) {
      window.nexsafeAdminLocationMap.remove();
      window.nexsafeAdminLocationMap = null;
    }
    
    if (canShowAdminMap) {
      setTimeout(function () {
    
        var mapContainer =
          document.getElementById("adminLocationMap");
    
        if (!mapContainer) {
          console.log("Admin map container not found.");
          return;
        }
    
        var region =
          window.NEXSAFE_LOCATION_REGION ||
          "ap-southeast-2";
    
        var mapStyleUrl =
          "https://maps.geo." +
          region +
          ".amazonaws.com/v2/styles/Standard/descriptor?key=" +
          window.NEXSAFE_LOCATION_API_KEY;
    
        window.nexsafeAdminLocationMap =
          new maplibregl.Map({
            container: "adminLocationMap",
            style: mapStyleUrl,
    
            center: [
              locationInfo.longitude,
              locationInfo.latitude
            ],
    
            zoom: 18
          });
    
        window.nexsafeAdminLocationMap.addControl(
          new maplibregl.NavigationControl(),
          "top-right"
        );
    
        new maplibregl.Marker()
          .setLngLat([
            locationInfo.longitude,
            locationInfo.latitude
          ])
          .addTo(
            window.nexsafeAdminLocationMap
          );
    
        // Maps inside a modal sometimes need resizing
        // after the modal becomes visible.
        window.nexsafeAdminLocationMap.on(
          "load",
          function () {
            window.nexsafeAdminLocationMap.resize();
          }
        );
    
        setTimeout(function () {
          if (window.nexsafeAdminLocationMap) {
            window.nexsafeAdminLocationMap.resize();
          }
        }, 300);
    
      }, 150);
    }
    
    if (isStaff) {
      $("#statusSelect").addEventListener("change", function (e) {
      updateStatus(report.id, e.target.value);
    });
    $("#prioritySelect").addEventListener("change", function (e) {
      updatePriority(report.id, e.target.value || null);
    });
    $("#saveStaffUpdateBtn").addEventListener("click", function () {
      var message = $("#staffUpdateInput").value.trim();
      awsApi.updateReport(report.id, { staff_update: message }).then(function (response) {
        if (response.statusCode !== 200) {
          showToast("Unable to save staff update", "error");
          return;
        }
        showToast("Staff update saved");
        openReportModal(response.body);
        notifyDataChanged();
      });
    });
    $("#deleteReportBtn").addEventListener("click", function () {
      showDeleteConfirm(report);
    });
  }
}

/* Swaps the "Delete this report" link for an inline Cancel / Yes, delete
   confirmation, so a stray click can't destroy data. */
function showDeleteConfirm(report) {
  var zone = $("#modalDanger");
  zone.innerHTML =
    '<p class="modal__danger-confirm">Delete this report? This can\'t be undone.</p>' +
    '<div class="modal__danger-actions">' +
      '<button type="button" class="btn btn--ghost btn--sm" id="cancelDeleteBtn">Cancel</button>' +
      '<button type="button" class="btn btn--danger btn--sm" id="confirmDeleteBtn">Yes, delete</button>' +
    '</div>';

  $("#cancelDeleteBtn").addEventListener("click", function () {
    openReportModal(report);
  });
  $("#confirmDeleteBtn").addEventListener("click", function () {
    // Real DELETE {AWS_API_BASE}/reports/{id} -> API Gateway -> Lambda -> RDS
    awsApi.deleteReport(report.id).then(function (res) {
      if (res.statusCode !== 200) return;
      closeReportModal();
      showToast("Report deleted");
      notifyDataChanged();
    });
  });
}

function closeReportModal() {
  if (!modal) return;
  modal.hidden = true;
  currentModalReport = null;
}

if (modal) {
  $$("[data-close-modal]").forEach(function (el) {
    el.addEventListener("click", closeReportModal);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.hidden) closeReportModal();
  });
}

function updateStatus(reportId, newStatus) {
  awsApi.updateReport(reportId, { status: newStatus }).then(function (response) {
    if (response.statusCode !== 200) {
      showToast("Unable to update status", "error");
      return;
    }
    showToast("Status updated");
    openReportModal(response.body);
    notifyDataChanged();
  });
}

function updatePriority(reportId, newPriority) {
  awsApi.updateReport(reportId, { priority: newPriority }).then(function (response) {
    if (response.statusCode !== 200) {
      showToast("Unable to update priority", "error");
      return;
    }
    showToast("Priority updated");
    openReportModal(response.body);
    notifyDataChanged();
  });
}

/* Every page starts by restoring the signed-in Cognito user. Report data is fetched from RDS by page-specific loaders. */
loadState();

/* If a staff member changes a report in another browser/tab, re-fetch the
   latest RDS data when this page becomes active again. */
function refreshCurrentPageFromRds() {
  if (
    currentUser &&
    typeof onDataChanged === "function"
  ) {
    onDataChanged();
  }

  if (currentUser) {
    refreshNexSafeNotificationBell();
  }
}

window.addEventListener("focus", function () {
  refreshCurrentPageFromRds();
});

document.addEventListener("visibilitychange", function () {
  if (!document.hidden) {
    refreshCurrentPageFromRds();
  }
});
