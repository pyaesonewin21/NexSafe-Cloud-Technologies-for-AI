/* =========================================================
   NexSafe — landing.js
   Only runs on the public marketing page (index.html).
   Depends on js/common.js being loaded first.
   ========================================================= */

// currentUser comes from common.js (it was filled in by loadState()
// reading localStorage). If someone is already signed in, there's no
// point showing them the marketing page again — send them to the app.
if (currentUser) {
  // Already signed in — go straight to the app instead of the marketing page.
  window.location.href = "home.html";
} else {
  // Shows a toast if one was saved just before we got redirected here
  // (see setFlashMessage / showFlashMessageIfAny in common.js).
  showFlashMessageIfAny();

  // Fills in the "© 2026" year in the footer automatically, so we never
  // have to remember to update it by hand every January.
  $("#year").textContent = new Date().getFullYear();

  // ---------- Scroll-reveal animation ----------
  // Every element with class="reveal" starts invisible (see the CSS).
  // An IntersectionObserver is a browser feature that watches a list of
  // elements and tells us the moment one of them scrolls into view.
  // When that happens, we add "is-visible" to it, which is what actually
  // triggers the fade-in animation in the CSS. io.unobserve(...) then
  // stops watching that element, since it only needs to fade in once.
  var revealEls = $$(".reveal");
  if ("IntersectionObserver" in window) {
    // Older browsers might not support IntersectionObserver, so we check
    // for it first with "in window" before trying to use it.
    var io = new IntersectionObserver(function (entries) {
      // "entries" is the list of elements whose visibility just changed.
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          // isIntersecting = true means this element is now on screen.
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    // threshold: 0.12 means "count it as visible once 12% of it is on
    // screen" (so it starts fading in a little before fully in view).
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    // Fallback for old browsers: just show everything immediately,
    // no fade-in animation.
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  }
}
