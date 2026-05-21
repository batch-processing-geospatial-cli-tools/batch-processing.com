// Convert FAQ/Frequently Asked Questions headings + following content into
// <details><summary> accordions.
(function () {
  function initAccordions() {
    const prose = document.querySelector(".prose");
    if (!prose) return;

    const headings = prose.querySelectorAll("h2, h3");
    headings.forEach(function (heading) {
      const text = heading.textContent.trim().toLowerCase();
      if (
        !text.includes("faq") &&
        !text.includes("frequently asked") &&
        !text.includes("questions")
      ) {
        return;
      }

      // Gather all sibling h3/h4 + p pairs after this heading until next h2
      let sibling = heading.nextElementSibling;
      while (sibling) {
        const tag = sibling.tagName.toLowerCase();
        if (tag === "h2") break; // Stop at next section

        // h3/h4 followed by paragraph(s) → accordion item
        if ((tag === "h3" || tag === "h4") && sibling.nextElementSibling) {
          const question = sibling.textContent.trim();
          const details = document.createElement("details");
          details.className = "faq-item";

          const summary = document.createElement("summary");
          summary.textContent = question;
          details.appendChild(summary);

          const answer = document.createElement("div");
          answer.className = "faq-answer";

          // Collect following paragraphs
          let next = sibling.nextElementSibling;
          const toRemove = [sibling];
          while (next && !["h2", "h3", "h4"].includes(next.tagName.toLowerCase())) {
            toRemove.push(next);
            answer.appendChild(next.cloneNode(true));
            next = next.nextElementSibling;
          }

          details.appendChild(answer);

          // Insert details before first element
          sibling.parentNode.insertBefore(details, sibling);
          toRemove.forEach((el) => el.remove());
          sibling = next;
          continue;
        }
        sibling = sibling.nextElementSibling;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAccordions);
  } else {
    initAccordions();
  }
})();

