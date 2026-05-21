// Persist checkbox state in localStorage, keyed by page URL + checkbox index
(function () {
  function getPageKey() {
    return "cb:" + window.location.pathname;
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(getPageKey()) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(getPageKey(), JSON.stringify(state));
    } catch (e) {}
  }

  function initCheckboxes() {
    const checkboxes = document.querySelectorAll(
      '.prose input[type="checkbox"]'
    );
    if (!checkboxes.length) return;

    const state = loadState();

    checkboxes.forEach(function (cb, idx) {
      // Restore saved state
      if (state[idx] !== undefined) {
        cb.checked = state[idx];
      }

      // Make sure they're not disabled
      cb.removeAttribute("disabled");

      cb.addEventListener("change", function () {
        const current = loadState();
        current[idx] = cb.checked;
        saveState(current);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCheckboxes);
  } else {
    initCheckboxes();
  }
})();

