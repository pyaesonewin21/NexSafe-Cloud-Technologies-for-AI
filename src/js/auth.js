/* =========================================================
   NexSafe — auth.js
   REAL Amazon Cognito authentication for the existing NexSafe auth.html.

   Cognito:
   Region: ap-southeast-2
   User Pool ID: ap-southeast-2_7O0q41gL7
   App Client ID: 26s4f1lhaf0hmk39ajkik4pv20

   IMPORTANT:
   In Cognito App Client authentication flows, enable:
   - ALLOW_USER_PASSWORD_AUTH
   - ALLOW_REFRESH_TOKEN_AUTH

   Users are created by the administrator and placed in:
   - students
   - staff

   No client secret is used in browser code.
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

function decodeBase64Url(value) {
  var base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";

  var binary = atob(base64);
  var bytes = [];

  for (var i = 0; i < binary.length; i++) {
    bytes.push("%" + ("00" + binary.charCodeAt(i).toString(16)).slice(-2));
  }

  return decodeURIComponent(bytes.join(""));
}

function decodeJwt(token) {
  try {
    var parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch (error) {
    console.error("Unable to decode Cognito token:", error);
    return null;
  }
}

function isCurrentCognitoSessionValid() {
  var idToken = localStorage.getItem("nexsafe_cognito_id_token");
  var claims = decodeJwt(idToken);

  if (!claims) return false;

  var now = Math.floor(Date.now() / 1000);

  return (
    claims.iss === COGNITO_ISSUER &&
    claims.aud === COGNITO_CLIENT_ID &&
    Number(claims.exp || 0) > now
  );
}

function clearCognitoSession() {
  localStorage.removeItem("nexsafe_cognito_id_token");
  localStorage.removeItem("nexsafe_cognito_access_token");
  localStorage.removeItem("nexsafe_cognito_refresh_token");
  localStorage.removeItem("nexsafe_cognito_username");
  localStorage.removeItem("nexsafe_user");
  currentUser = null;
}

function cognitoRequest(operation, payload) {
  return fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target":
        "AWSCognitoIdentityProviderService." + operation
    },
    body: JSON.stringify(payload)
  }).then(function (response) {
    return response
      .json()
      .catch(function () {
        return {};
      })
      .then(function (data) {
        if (!response.ok) {
          var error = new Error(
            data.message ||
            data.Message ||
            "Amazon Cognito request failed."
          );

          error.name =
            (data.__type || "").split("#").pop() ||
            "CognitoError";

          error.cognitoData = data;
          throw error;
        }

        return data;
      });
  });
}

function cognitoSignIn(email, password) {
  return cognitoRequest("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password
    }
  });
}

function completeNewPasswordChallenge(authResult, originalEmail, newPassword) {
  var challengeParameters = authResult.ChallengeParameters || {};

  var challengeUsername =
    challengeParameters.USER_ID_FOR_SRP ||
    challengeParameters.USERNAME ||
    originalEmail;

  return cognitoRequest("RespondToAuthChallenge", {
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    ClientId: COGNITO_CLIENT_ID,
    Session: authResult.Session,
    ChallengeResponses: {
      USERNAME: challengeUsername,
      NEW_PASSWORD: newPassword
    }
  });
}

function prettyNameFromEmail(email) {
  var localPart = String(email || "")
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .trim();

  if (!localPart) return "User";

  return localPart
    .split(/\s+/)
    .map(function (part) {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function finishCognitoLogin(authenticationResult, selectedRole) {
  if (
    !authenticationResult ||
    !authenticationResult.IdToken ||
    !authenticationResult.AccessToken
  ) {
    throw new Error("Cognito did not return login tokens.");
  }

  var claims = decodeJwt(authenticationResult.IdToken);

  if (!claims) {
    throw new Error("Unable to read the Cognito ID token.");
  }

  if (claims.iss !== COGNITO_ISSUER) {
    throw new Error("The login token came from an unexpected user pool.");
  }

  if (claims.aud !== COGNITO_CLIENT_ID) {
    throw new Error("The login token is not for NexSafe-Web.");
  }

  var groups = claims["cognito:groups"] || [];
  var actualRole = null;

  if (groups.indexOf("staff") !== -1) {
    actualRole = "staff";
  } else if (groups.indexOf("students") !== -1) {
    actualRole = "student";
  }

  if (!actualRole) {
    throw new Error(
      "This Cognito account is not assigned to the students or staff group."
    );
  }

  if (actualRole !== selectedRole) {
    var correctLabel = actualRole === "student" ? "Student" : "Staff";

    throw new Error(
      "This account belongs to the " +
      correctLabel +
      " group. Please choose " +
      correctLabel +
      " sign in."
    );
  }

  var email =
    claims.email ||
    claims["cognito:username"] ||
    "";

  var displayName =
    claims.name ||
    prettyNameFromEmail(email);

  currentUser = {
    email: email,
    name: displayName,
    role: actualRole,
    sub: claims.sub
  };

  localStorage.setItem(
    "nexsafe_cognito_id_token",
    authenticationResult.IdToken
  );

  localStorage.setItem(
    "nexsafe_cognito_access_token",
    authenticationResult.AccessToken
  );

  if (authenticationResult.RefreshToken) {
    localStorage.setItem(
      "nexsafe_cognito_refresh_token",
      authenticationResult.RefreshToken
    );
  }

  localStorage.setItem(
    "nexsafe_cognito_username",
    claims["cognito:username"] || email
  );

  localStorage.setItem(
    "nexsafe_user",
    JSON.stringify(currentUser)
  );

  setFlashMessage("Welcome back!");
  window.location.href = "home.html";
}

if (currentUser && isCurrentCognitoSessionValid()) {
  window.location.href = "home.html";

} else {

  if (currentUser) {
    clearCognitoSession();
  }

  var authRole = "student";

  var roleToggle = $("#roleToggle");
  var authTitle = $("#authTitle");
  var authSub = $("#authSub");
  var authSubmit = $("#authSubmit");
  var nameField = $("#nameField");
  var switchMode = $("#switchMode");
  var roleNote = $("#roleNote");
  var authError = $("#authError");
  var authForm = $("#authForm");

  var pwToggle = $("#pwToggle");
  var pwInput = $("#auth-pass");

  nameField.hidden = true;

  var switchContainer =
    switchMode
      ? switchMode.closest(".auth__switch")
      : null;

  if (switchContainer) {
    switchContainer.hidden = true;
  }

  var roleNotes = {
    student:
      "Students sign in with student portal account and password.",

    staff:
      "Staff sign in with an Amazon Cognito account assigned to the staff group."
  };

  function updateAuthUI() {
    var roleLabel =
      authRole === "student"
        ? "Student"
        : "Staff";

    authTitle.textContent =
      roleLabel + " sign in";

    authSub.textContent =
      "Sign in securely with your NexSafe Amazon Cognito account.";

    authSubmit.textContent = "Sign in";
    roleNote.textContent = roleNotes[authRole];

    $$(".role-toggle__btn").forEach(function (button) {
      button.classList.toggle(
        "is-active",
        button.dataset.role === authRole
      );
    });
  }

  roleToggle.addEventListener("click", function (event) {
    var button = event.target.closest(".role-toggle__btn");
    if (!button) return;

    authRole = button.dataset.role;
    authError.hidden = true;
    updateAuthUI();
  });

  pwToggle.addEventListener("click", function () {
    var isText = pwInput.type === "text";

    pwInput.type =
      isText
        ? "password"
        : "text";

    pwToggle.setAttribute(
      "aria-label",
      isText ? "Show password" : "Hide password"
    );
  });

  function setFieldError(input, on) {
    var field = input.closest(".field");
    if (!field) return;

    field.classList.toggle("has-error", on);
  }

  function validateEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function showAuthError(message) {
    authError.textContent =
      message ||
      "Unable to sign in.";

    authError.hidden = false;
    authSubmit.disabled = false;
    authSubmit.textContent = "Sign in";
  }

  function askForPermanentPassword() {
    var newPassword = window.prompt(
      "First Cognito sign-in: enter a NEW permanent password.\n\nUse a strong password that meets your Cognito password policy."
    );

    if (newPassword === null) {
      throw new Error(
        "Password change cancelled. Sign in again when you are ready."
      );
    }

    if (!newPassword.trim()) {
      throw new Error("The new password cannot be empty.");
    }

    return newPassword;
  }

  authForm.addEventListener("submit", function (event) {
    event.preventDefault();
    authError.hidden = true;

    var email = $("#auth-email").value.trim().toLowerCase();
    var password = $("#auth-pass").value;

    var emailInput = $("#auth-email");
    var valid = true;

    if (!validateEmail(email)) {
      setFieldError(emailInput, true);
      valid = false;
    } else {
      setFieldError(emailInput, false);
    }

    if (!password) {
      setFieldError(pwInput, true);
      valid = false;
    } else {
      setFieldError(pwInput, false);
    }

    if (!valid) return;

    authSubmit.disabled = true;
    authSubmit.textContent = "Signing in…";

    cognitoSignIn(email, password)
      .then(function (result) {

        if (result.ChallengeName === "NEW_PASSWORD_REQUIRED") {
          var newPassword = askForPermanentPassword();

          authSubmit.textContent =
            "Setting new password…";

          return completeNewPasswordChallenge(
            result,
            email,
            newPassword
          );
        }

        return result;
      })
      .then(function (result) {

        if (
          result.ChallengeName &&
          !result.AuthenticationResult
        ) {
          throw new Error(
            "Cognito requires an unsupported challenge: " +
            result.ChallengeName
          );
        }

        finishCognitoLogin(
          result.AuthenticationResult,
          authRole
        );
      })
      .catch(function (error) {
        console.error("Cognito sign-in error:", error);

        var message =
          error.message ||
          "Unable to sign in.";

        if (error.name === "NotAuthorizedException") {
          message = "Incorrect email or password.";
        }

        if (error.name === "UserNotFoundException") {
          message =
            "No Cognito account was found for this email.";
        }

        if (error.name === "UserNotConfirmedException") {
          message =
            "This Cognito account is not confirmed yet.";
        }

        if (error.name === "PasswordResetRequiredException") {
          message =
            "Amazon Cognito requires a password reset for this account.";
        }

        if (
          error.name === "InvalidParameterException" &&
          message.toLowerCase().indexOf("auth flow") !== -1
        ) {
          message =
            "USER_PASSWORD_AUTH is not enabled for the NexSafe-Web Cognito app client yet.";
        }

        showAuthError(message);
      });
  });

  authForm.addEventListener("input", function (event) {
    var field = event.target.closest(".field");

    if (field) {
      field.classList.remove("has-error");
    }

    authError.hidden = true;
  });

  updateAuthUI();
}
