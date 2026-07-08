(function () {
  "use strict";

  var doc = document.querySelector(".nog-doc");
  if (!doc) return;

  var docId = document.body.getAttribute("data-doc-id") || "";
  var formName = document.body.getAttribute("data-form-name") || "nog-comment";
  var BLOCK_RE = /^\s*nog:(blk-[\w-]+)\s*$/;

  function wrapBlocks() {
    var walker = document.createTreeWalker(doc, NodeFilter.SHOW_COMMENT, null);
    var markers = [];
    var node;
    while ((node = walker.nextNode())) {
      var m = node.data.match(BLOCK_RE);
      if (m) markers.push({ comment: node, blockId: m[1] });
    }

    markers.forEach(function (marker, i) {
      var start = marker.comment;
      var parent = start.parentNode;
      var wrapper = document.createElement("div");
      wrapper.className = "nog-block";
      wrapper.setAttribute("data-block-id", marker.blockId);

      var stopAt = markers[i + 1] ? markers[i + 1].comment : null;
      var collected = [];
      var cursor = start.nextSibling;
      while (cursor && cursor !== stopAt) {
        var next = cursor.nextSibling;
        collected.push(cursor);
        cursor = next;
      }

      parent.insertBefore(wrapper, start);
      collected.forEach(function (el) { wrapper.appendChild(el); });
      parent.removeChild(start);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nog-comment-btn";
      btn.setAttribute("aria-label", "Comment on this block");
      btn.textContent = "+";
      btn.addEventListener("click", function () {
        openPanel(marker.blockId, null);
      });
      wrapper.appendChild(btn);
    });
  }

  // --- Selection -> floating "Add comment" button, snapped to enclosing block ---

  var floatBtn = null;

  function removeFloatBtn() {
    if (floatBtn) {
      floatBtn.remove();
      floatBtn = null;
    }
  }

  function enclosingBlock(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    return el ? el.closest(".nog-block") : null;
  }

  document.addEventListener("mouseup", function (e) {
    if (e.target.closest(".nog-panel-backdrop") || e.target.closest(".nog-float-btn")) return;
    removeFloatBtn();

    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var text = sel.toString().trim();
    if (!text) return;

    var range = sel.getRangeAt(0);
    var block = enclosingBlock(range.commonAncestorContainer);
    if (!block) return;

    var rect = range.getBoundingClientRect();
    floatBtn = document.createElement("button");
    floatBtn.type = "button";
    floatBtn.className = "nog-float-btn";
    floatBtn.textContent = "Add comment";
    floatBtn.style.top = (window.scrollY + rect.top - 38) + "px";
    floatBtn.style.left = (window.scrollX + rect.left) + "px";
    floatBtn.addEventListener("mousedown", function (evt) {
      evt.preventDefault(); // keep selection alive through the click
    });
    floatBtn.addEventListener("click", function () {
      openPanel(block.getAttribute("data-block-id"), text);
      removeFloatBtn();
    });
    document.body.appendChild(floatBtn);
  });

  document.addEventListener("mousedown", function (e) {
    if (floatBtn && !e.target.closest(".nog-float-btn")) removeFloatBtn();
  });

  // --- Comment panel ---

  function openPanel(blockId, excerpt) {
    var backdrop = document.createElement("div");
    backdrop.className = "nog-panel-backdrop";

    var panel = document.createElement("div");
    panel.className = "nog-panel";

    var heading = document.createElement("h2");
    heading.textContent = "Comment on " + blockId;
    panel.appendChild(heading);

    if (excerpt) {
      var ex = document.createElement("blockquote");
      ex.className = "nog-panel-excerpt";
      ex.textContent = excerpt;
      panel.appendChild(ex);
    }

    panel.appendChild(
      field("comment_text", "Comment", "textarea", "What would you change, and why?", true)
    );
    panel.appendChild(
      field("candidate_edit", "Proposed replacement wording (optional)", "textarea",
        "Leave blank if you just want to raise the point.", false)
    );
    panel.appendChild(
      field("commenter_name", "Your name (optional)", "input", "", false)
    );

    var status = document.createElement("div");
    status.className = "nog-status";

    var actions = document.createElement("div");
    actions.className = "nog-panel-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "nog-btn nog-btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);

    var submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "nog-btn nog-btn-primary";
    submitBtn.textContent = "Submit";
    submitBtn.addEventListener("click", function () {
      var commentText = panel.querySelector('[name="comment_text"]').value.trim();
      if (!commentText) {
        status.textContent = "A comment is required.";
        status.className = "nog-status nog-status-error";
        return;
      }
      submitBtn.disabled = true;
      status.textContent = "Submitting…";
      status.className = "nog-status";

      var payload = {
        "form-name": formName,
        doc_id: docId,
        block_id: blockId,
        comment_text: commentText,
        candidate_edit: panel.querySelector('[name="candidate_edit"]').value.trim(),
        commenter_name: panel.querySelector('[name="commenter_name"]').value.trim()
      };

      submitForm(payload)
        .then(function () {
          status.textContent = "Thanks — your comment was submitted.";
          status.className = "nog-status nog-status-ok";
          submitBtn.remove();
          cancelBtn.textContent = "Close";
        })
        .catch(function () {
          status.textContent = "Something went wrong submitting that. Please try again.";
          status.className = "nog-status nog-status-error";
          submitBtn.disabled = false;
        });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    panel.appendChild(status);
    panel.appendChild(actions);

    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }

    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", onKey);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    panel.querySelector('[name="comment_text"]').focus();
  }

  function field(name, labelText, tag, placeholder, required) {
    var wrap = document.createElement("div");
    wrap.className = "nog-field";
    var label = document.createElement("label");
    label.textContent = labelText;
    var input = document.createElement(tag);
    input.name = name;
    if (placeholder) input.placeholder = placeholder;
    if (required) input.required = true;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function submitForm(fields) {
    var body = Object.keys(fields)
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(fields[k] || ""); })
      .join("&");

    return fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body
    }).then(function (res) {
      if (!res.ok) throw new Error("Submission failed: " + res.status);
    });
  }

  wrapBlocks();
})();
