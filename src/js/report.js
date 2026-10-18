

if (requireRole("student")) {
  setupAppUI();

  var reportForm = $("#reportForm");
  var reportHeadForm = $("#reportHeadForm");
  var reportContinueBtn = $("#reportContinueBtn");
  var reportHint = $("#reportHint");

  // The student now picks a specific issue type (e.g. "Broken Chair"),
  // not a broad category. The broad category is worked out automatically
  // from ISSUE_TYPE_TO_CATEGORY (defined in common.js).
  var issueTypeSelect = $("#r-issue-type");
  var issueTypeCategoryHint = $("#issueTypeCategory");

  var reportConfirm = $("#reportConfirm");
  var confirmPhoto = $("#confirmPhoto");
  var confirmCategory = $("#confirmCategory");
  var confirmTitle = $("#confirmTitle");
  var confirmLocation = $("#confirmLocation");
  var confirmDescription = $("#confirmDescription");
  var confirmMeta = $("#confirmMeta");
  var editReportBtn = $("#editReportBtn");
  var confirmSubmitBtn = $("#confirmSubmitBtn");
  var confirmSubmitLabel = $("#confirmSubmitLabel");

  // Holds the validated form data between clicking "Submit" (step 1) and
  // clicking "Confirm & submit" (step 2), so the final submitReport()
  // function has something to send.
  var pendingReportFields = null;

  /*  Photo upload / preview  */
  var dropzone = $("#dropzone");
  var photoInput = $("#r-photo");
  var dropzoneEmpty = $("#dropzoneEmpty");
  var dropzonePreview = $("#dropzonePreview");
  var dropzonePreviewImg = $("#dropzonePreviewImg");
  var dropzoneRemove = $("#dropzoneRemove");
  var scanResult = $("#scanResult");

  var selectedPhotoName = null;
  var selectedPhotoDataUrl = null;

  // The image itself is uploaded to S3 during the verification step.
  // Only the resulting S3 URL/path is later saved in RDS.
  var uploadedImageKey = null;
  var uploadedImageUrl = null;
  // verificationState is a "state machine" — a variable that can only be
  // one of a fixed list of named values, and different code runs
  // depending on which one it currently is. Here it can be:
  //   "none"             - no photo yet, or no issue type picked yet
  //   "analyzing"        - waiting for the AWS upload/Rekognition call
  //   "matched"          - AI predicted the exact same issue type
  //   "type_mismatch"    - AI predicted a different issue type, but the
  //                        same broad category (soft warning, can continue)
  //   "category_mismatch" - AI predicted a completely different category
  //                        (hard block, must be resolved)
  //   "unrecognized"     - AI could not recognise anything in the photo
  //                        (flagged for manual staff review, can continue)
  //   "skipped"          - student chose "Other", verification skipped
  var verificationState = "none";
  var verificationResult = null;

  // Clears everything about the currently picked photo, back to the
  // starting state — used both when the student clicks "Remove photo"
  // and when they upload a different photo after a category mismatch.
  function resetPhotoState() {
    selectedPhotoName = null;
    selectedPhotoDataUrl = null;
    uploadedImageKey = null;
    uploadedImageUrl = null;
    verificationState = "none";
    verificationResult = null;
    photoInput.value = "";
    dropzonePreview.hidden = true;
    dropzoneEmpty.hidden = false;
    scanResult.hidden = true;
    scanResult.innerHTML = "";
    dropzone.closest(".field").classList.remove("has-error");
    updateContinueButton();
  }


  /* Continuing is allowed once we have a photo AND the verification result
     is one of the "safe to move on" states. category_mismatch is the only
     state that blocks the student — it has to be resolved first. */
  function updateContinueButton() {
    var readyStates = ["matched", "type_mismatch", "skipped", "unrecognized"];
    // .indexOf(x) returns the position of x in the array, or -1 if it's
    // not there at all — so "!== -1" is just "is verificationState one
    // of these four allowed values?"
    var isReadyState = readyStates.indexOf(verificationState) !== -1;
    // "!!something" turns any value into a plain true/false. A photo's
    // data URL is either a long text string (truthy) or null (falsy),
    // so !!selectedPhotoDataUrl becomes exactly true or false.
    var ready = !!selectedPhotoDataUrl && isReadyState;
    reportContinueBtn.disabled = !ready;

    if (!selectedPhotoDataUrl) {
      reportHint.textContent = "Upload a photo to continue.";
    } else if (verificationState === "analyzing") {
      reportHint.textContent = "Analysing your photo…";
    } else if (verificationState === "category_mismatch") {
      reportHint.textContent = "Resolve the category mismatch below to continue.";
    } else {
      reportHint.textContent = "You'll review everything before it's submitted.";
    }
  }

  /* Shows the broad category under the issue-type dropdown, e.g.
     "Category: Maintenance Issues", so the student can see it was
     assigned automatically. */
  function updateIssueTypeCategoryHint() {
    var issueType = issueTypeSelect.value;
    if (!issueType) {
      issueTypeCategoryHint.textContent = "";
      return;
    }
    var category = ISSUE_TYPE_TO_CATEGORY[issueType];
    issueTypeCategoryHint.textContent = "Category: " + category;
  }

  // Clicking anywhere on the empty dropzone opens the hidden file picker.
  dropzoneEmpty.addEventListener("click", function () { photoInput.click(); });

  photoInput.addEventListener("change", function () {
    var file = photoInput.files[0]; // the file the student just picked
    if (!file) return;

    // A file on the student's computer can't be shown directly in an
    // <img> tag — browsers block that for privacy reasons. FileReader
    // reads the file's actual bytes and turns them into a "data URL"
    // (the image encoded as one long piece of text), which CAN be set
    // as an <img>'s src. Reading takes a moment, so reader.onload is a
    // callback that runs once the reading has actually finished.
    var reader = new FileReader();
    reader.onload = function (e) {
      selectedPhotoName = file.name;
      selectedPhotoDataUrl = e.target.result; // the finished data URL
      uploadedImageKey = null;
      uploadedImageUrl = null;
      dropzonePreviewImg.src = selectedPhotoDataUrl;
      dropzoneEmpty.hidden = true;
      dropzonePreview.hidden = false;
      dropzone.closest(".field").classList.remove("has-error");
      runVerification();
    };
    reader.readAsDataURL(file);
  });

  dropzoneRemove.addEventListener("click", function (e) {
    // Stops the click from "bubbling up" to the dropzone's own click
    // handler above (which would immediately reopen the file picker).
    e.stopPropagation();
    resetPhotoState();
  });

  issueTypeSelect.addEventListener("change", function () {
    issueTypeSelect.closest(".field").classList.remove("has-error");
    updateIssueTypeCategoryHint();
    if (selectedPhotoDataUrl) runVerification();
  });

  /* Uploads the selected image to S3 and, for supported issue types,
     runs the real AWS Rekognition Custom Labels model.

     If the student changes only the issue type, uploadedImageKey is sent
     back to Lambda so the existing S3 object is reused instead of uploading
     the same photo again. */
  function runVerification() {
    var issueType = issueTypeSelect.value;

    if (!selectedPhotoDataUrl) {
      verificationState = "none";
      updateContinueButton();
      return;
    }

    if (!issueType) {
      verificationState = "none";
      scanResult.hidden = false;
      scanResult.className =
        "scan-result scan-result--loading";
      scanResult.innerHTML =
        "Select an issue type above to verify this photo.";
      updateContinueButton();
      return;
    }

    verificationState = "analyzing";
    scanResult.hidden = false;
    scanResult.className =
      "scan-result scan-result--loading";

    if (issueType === "Other") {
      scanResult.innerHTML =
        '<span class="spinner"></span> Uploading photo securely to Amazon S3…';
    } else {
      scanResult.innerHTML =
        '<span class="spinner"></span> Uploading photo to Amazon S3 and analysing with AWS Rekognition…';
    }

    updateContinueButton();

    var requestIssueType = issueType;
    var requestPhotoDataUrl =
      selectedPhotoDataUrl;

    awsApi.analyzeImage(
      selectedPhotoDataUrl,
      issueType,
      {
        imageKey: uploadedImageKey,
        uploadOnly: issueType === "Other",
        fileName: selectedPhotoName
      }
    ).then(function (response) {

      // Ignore an old response if the student changed photo/issue while
      // this request was still running.
      if (
        selectedPhotoDataUrl !== requestPhotoDataUrl ||
        issueTypeSelect.value !== requestIssueType
      ) {
        return;
      }

      if (response.statusCode !== 200) {
        verificationState = "none";
        scanResult.className =
          "scan-result scan-result--warn";

        var message =
          response &&
          response.body &&
          response.body.message
            ? response.body.message
            : "Please try again.";

        scanResult.innerHTML =
          '<p class="scan-result__title">Unable to upload/analyse photo</p>' +
          '<p class="scan-result__body">' +
          escapeHtml(message) +
          '</p>';

        updateContinueButton();
        return;
      }

      verificationResult =
        response.body || {};

      uploadedImageKey =
        verificationResult.imageKey ||
        uploadedImageKey;

      uploadedImageUrl =
        verificationResult.imageUrl ||
        uploadedImageUrl;

      // A successful request MUST return the stored S3 image information.
      if (!uploadedImageKey || !uploadedImageUrl) {
        verificationState = "none";
        scanResult.className =
          "scan-result scan-result--warn";
        scanResult.innerHTML =
          '<p class="scan-result__title">Photo storage was not completed</p>' +
          '<p class="scan-result__body">The AWS Lambda response did not include the S3 image path. Please try again.</p>';
        updateContinueButton();
        return;
      }

      // Keep the S3 reference together with the Rekognition result in RDS.
      verificationResult.imageKey =
        uploadedImageKey;
      verificationResult.imageUrl =
        uploadedImageUrl;

      if (issueType === "Other") {
        verificationState = "skipped";
        verificationResult.manual_review = true;

        scanResult.hidden = false;
        scanResult.className =
          "scan-result scan-result--match";
        scanResult.innerHTML =
          '<p class="scan-result__title">✓ Photo saved for manual review</p>' +
          '<p class="scan-result__body">The photo was uploaded to Amazon S3. "Other" reports skip automatic classification and will be reviewed by staff.</p>';

        updateContinueButton();
        return;
      }

      var selectedCategory =
        ISSUE_TYPE_TO_CATEGORY[issueType];

      if (!verificationResult.predicted_issue_type) {
        verificationState = "unrecognized";
        renderScanUnrecognized(
          verificationResult
        );
      } else if (verificationResult.matched) {
        verificationState = "matched";
        renderScanMatch(
          verificationResult
        );
      } else if (
        verificationResult.predicted_category ===
        selectedCategory
      ) {
        verificationState = "type_mismatch";
        renderScanTypeMismatch(
          verificationResult,
          issueType
        );
      } else {
        verificationState =
          "category_mismatch";
        renderScanCategoryMismatch(
          verificationResult,
          issueType
        );
      }

      updateContinueButton();
    });
  }

  function renderScanMatch(result) {
    scanResult.hidden = false;
    scanResult.className = "scan-result scan-result--match";
    scanResult.innerHTML =
      '<p class="scan-result__title">✓ Looks correct (' + result.confidence + '% confidence)</p>' +
      '<p class="scan-result__body">AWS Rekognition detected <strong>' + escapeHtml(result.predicted_issue_type) + '</strong>, which matches your selected issue type.</p>';
  }

  /* B: soft warning — the category is still right, so the student is
     allowed to continue either way, but we suggest switching to the
     issue type the AI actually predicted. */
  function renderScanTypeMismatch(result, issueType) {
    scanResult.hidden = false;
    scanResult.className = "scan-result scan-result--warn";
    scanResult.innerHTML =
      '<p class="scan-result__title">Possible issue type mismatch (' + result.confidence + '% confidence)</p>' +
      '<p class="scan-result__body">AWS Rekognition detected <strong>' + escapeHtml(result.predicted_issue_type) + '</strong>, which is a different issue type to "' + escapeHtml(issueType) + '" — but both are still <strong>' + escapeHtml(result.predicted_category) + '</strong>. You can keep your selection, or switch to match the AI\'s prediction.</p>' +
      '<div class="scan-result__actions">' +
        '<button type="button" class="btn btn--primary btn--sm" id="scanUseSuggestion">Use "' + escapeHtml(result.predicted_issue_type) + '" instead</button>' +
      '</div>';

    // This button only exists after the HTML above was inserted, so we
    // have to grab it and wire up its click listener AFTER innerHTML runs.
    $("#scanUseSuggestion").addEventListener("click", function () {
      issueTypeSelect.value = result.predicted_issue_type;
      updateIssueTypeCategoryHint();
      runVerification();
    });
  }

  /* C: hard block — a different broad category was predicted, so the
     mismatch has to actually be resolved before the student can continue. */
  function renderScanCategoryMismatch(result, issueType) {
    scanResult.hidden = false;
    scanResult.className = "scan-result scan-result--warn";
    scanResult.innerHTML =
      '<p class="scan-result__title">Category mismatch (' + result.confidence + '% confidence)</p>' +
      '<p class="scan-result__body">AWS Rekognition detected <strong>' + escapeHtml(result.predicted_issue_type) + '</strong> (' + escapeHtml(result.predicted_category) + ') in this photo, which doesn\'t match "' + escapeHtml(issueType) + '". Please do one of the following:</p>' +
      '<div class="scan-result__actions">' +
        '<button type="button" class="btn btn--ghost btn--sm" id="scanChangeIssueType">Change issue type</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="scanChangePhoto">Upload a different photo</button>' +
        '<button type="button" class="btn btn--primary btn--sm" id="scanChooseOther">Choose "Other" instead</button>' +
      '</div>';

    // Three ways the student can resolve a hard mismatch — none of them
    // let the student just "submit anyway", on purpose.
    $("#scanChangeIssueType").addEventListener("click", function () {
      issueTypeSelect.value = "";
      issueTypeSelect.focus();
      updateIssueTypeCategoryHint();
      runVerification();
    });
    $("#scanChangePhoto").addEventListener("click", function () {
      resetPhotoState();
      photoInput.click();
    });
    $("#scanChooseOther").addEventListener("click", function () {
      issueTypeSelect.value = "Other";
      updateIssueTypeCategoryHint();
      runVerification();
    });
  }

  /* D: nothing recognisable in the photo — we don't pretend it was
     verified, we just flag it for a staff member to check by hand. */
  function renderScanUnrecognized(result) {
    scanResult.hidden = false;
    scanResult.className = "scan-result scan-result--warn";
    scanResult.innerHTML =
      '<p class="scan-result__title">Photo not recognised (' + result.confidence + '% confidence)</p>' +
      '<p class="scan-result__body">AWS Rekognition could not confidently recognise this photo. It will be flagged for manual staff review instead.</p>';
  }

  /* ---------- Step 1 -> Step 2: validate + show the confirmation screen ---------- */
  reportContinueBtn.addEventListener("click", function () {
    var title = $("#r-title").value.trim();
    var issueType = issueTypeSelect.value;
    var building = $("#r-building").value.trim();
    var level = $("#r-level").value.trim();
    var exact = $("#r-exact").value.trim();
    var description = $("#r-desc").value.trim();

    // Instead of writing one big if-statement checking 6 fields, we put
    // them all in a list and loop through it — adding a 7th required
    // field later would just mean adding one more line to this list.
    var fields = [
      { id: "r-title", val: title },
      { id: "r-issue-type", val: issueType },
      { id: "r-building", val: building },
      { id: "r-level", val: level },
      { id: "r-exact", val: exact },
      { id: "r-desc", val: description },
    ];
    var valid = true;
    fields.forEach(function (f) {
      var input = $("#" + f.id);
      var field = input.closest(".field");
      var empty = !f.val; // empty string is falsy, so !f.val means "is this blank?"
      field.classList.toggle("has-error", empty);
      if (empty) valid = false;
    });

    // The photo is checked separately since it isn't a text field with
    // a .value — it's tracked in our own selectedPhotoDataUrl variable.
    var photoField = dropzone.closest(".field");
    var photoOk = !!selectedPhotoDataUrl;
    photoField.classList.toggle("has-error", !photoOk);
    if (!photoOk) valid = false;

    if (!valid) {
      // Find the first field that ended up with an error, and move the
      // student's cursor straight into it so they know where to fix.
      var firstErr = $(".field.has-error");
      if (firstErr) {
        var focusable = firstErr.querySelector("input, select, textarea");
        if (focusable) focusable.focus();
      }
      return;
    }

    // The broad category is never picked by the student — it's always
    // worked out automatically from the issue type they chose.
    var category = ISSUE_TYPE_TO_CATEGORY[issueType];

    showReportConfirm({
      title: title,
      issue_type: issueType,
      category: category,
      building: building,
      level: level,
      exact_location: exact,
      description: description,
    });
  });

  // Fills in the "Review your report" screen with everything the
  // student entered, then swaps from the form to the confirm screen.
  function showReportConfirm(fields) {
    pendingReportFields = fields;

    confirmPhoto.src = selectedPhotoDataUrl;
    confirmCategory.textContent = fields.category;
    confirmCategory.className = "tag modal__cat " + tagClass(fields.category);
    confirmTitle.textContent = fields.title;
    confirmLocation.textContent = fields.building + " · " + fields.level + " · " + fields.exact_location;
    confirmDescription.textContent = fields.description;

    // Build a small list of extra info lines (issue type + AI result)
    // to show under the description on the confirm screen.
    var metaBits = [];
    metaBits.push("Issue type: " + fields.issue_type);
    if (verificationState === "matched" && verificationResult) {
      metaBits.push("AI verification: matched (" + verificationResult.confidence + "% confidence)");
    } else if (verificationState === "type_mismatch" && verificationResult) {
      metaBits.push("AI verification: possible issue type mismatch, same category (" + verificationResult.confidence + "% confidence)");
    } else if (verificationState === "unrecognized") {
      metaBits.push("AI verification: not recognised — flagged for manual review");
    } else if (verificationState === "skipped") {
      metaBits.push("AI verification: skipped — flagged for manual review");
    }
    // .map(...) turns each line of text into its own <span>, then
    // .join("") glues all those <span> tags together into one string.
    confirmMeta.innerHTML = metaBits.map(function (b) { return "<span>" + escapeHtml(b) + "</span>"; }).join("");

    reportForm.hidden = true;
    reportHeadForm.hidden = true;
    reportConfirm.hidden = false;
  }

  // "Edit details" goes back to step 1 without losing anything the
  // student already typed (the form was only hidden, not cleared).
  editReportBtn.addEventListener("click", function () {
    reportConfirm.hidden = true;
    reportForm.hidden = false;
    reportHeadForm.hidden = false;
  });

  confirmSubmitBtn.addEventListener("click", function () {
    if (!pendingReportFields) return;
    submitReport(pendingReportFields);
  });

  function submitReport(fields) {
    if (!uploadedImageUrl || !uploadedImageKey) {
      showToast(
        "Photo upload has not completed yet. Please go back and wait for the AWS check to finish.",
        "error"
      );
      return;
    }

    var authorId = currentUser.email;
    var authorName = currentUser.name;
    var locationText = fields.building + ", " + fields.level + ", " + fields.exact_location;

    confirmSubmitBtn.disabled = true;
    confirmSubmitLabel.textContent = "Submitting…";

    // POST /reports -> reports Lambda -> RDS INSERT; image is already stored in S3
    awsApi.createReport({
      title: fields.title,
      issue_type: fields.issue_type,
      category: fields.category,
      building: fields.building,
      level: fields.level,
      exact_location: fields.exact_location,
      location: locationText,
      description: fields.description,
      status: "submitted",
      priority: null,
      author_id: authorId,
      author_name: authorName,
      // RDS stores an S3 image URL/path, NOT the Base64 image.
      image: uploadedImageUrl,
      rekognition: verificationResult,
    }).then(function (response) {
      console.log("NexSafe CREATE response:", response);

      if (response.statusCode !== 201) {
        confirmSubmitBtn.disabled = false;
        confirmSubmitLabel.textContent = "Confirm & submit";

        var errorMessage =
          response &&
          response.body &&
          response.body.message
            ? response.body.message
            : "Unable to submit report";

        showToast(
          "Unable to submit report: " + errorMessage,
          "error"
        );

        console.error(
          "NexSafe CREATE failed:",
          response
        );

        return;
      }
      // setFlashMessage stores the toast text so it survives the page
      // redirect below (see common.js — a toast fired right before
      // navigating away would normally never be seen).
      setFlashMessage("Report submitted — thank you!");
      window.location.href = "feed.html";
    });
  }

  // As soon as the student edits any field, clear its red error state.
  reportForm.addEventListener("input", function (e) {
    var field = e.target.closest(".field");
    if (field) field.classList.remove("has-error");
  });
}
