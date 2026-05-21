// Copy-to-clipboard for all code blocks
(function () {
  function addCopyButtons() {
    document.querySelectorAll(".code-block-wrapper").forEach(function (wrapper) {
      const pre = wrapper.querySelector("pre");
      if (!pre || wrapper.querySelector(".copy-btn")) return;

      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "Copy code");
      btn.textContent = "Copy";

      btn.addEventListener("click", function () {
        const code = pre.querySelector("code") || pre;
        navigator.clipboard
          .writeText(code.innerText)
          .then(function () {
            btn.textContent = "Copied!";
            btn.classList.add("copied");
            setTimeout(function () {
              btn.textContent = "Copy";
              btn.classList.remove("copied");
            }, 2000);
          })
          .catch(function () {
            // Fallback for browsers without clipboard API
            const range = document.createRange();
            range.selectNode(code);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.execCommand("copy");
            window.getSelection().removeAllRanges();
            btn.textContent = "Copied!";
            btn.classList.add("copied");
            setTimeout(function () {
              btn.textContent = "Copy";
              btn.classList.remove("copied");
            }, 2000);
          });
      });

      wrapper.appendChild(btn);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addCopyButtons);
  } else {
    addCopyButtons();
  }
})();

