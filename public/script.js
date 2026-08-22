(() => {
  const intro = document.getElementById("intro");
  const thread = document.getElementById("thread");
  const form = document.getElementById("composerForm");
  const input = document.getElementById("composerInput");
  const sendBtn = document.getElementById("sendBtn");
  const resetBtn = document.getElementById("resetBtn");

  const sessionId =
    sessionStorage.getItem("piquant_session") ||
    (() => {
      const id = crypto.randomUUID();
      sessionStorage.setItem("piquant_session", id);
      return id;
    })();

  let busy = false;

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  input.addEventListener("input", autoGrow);

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderFormatted(text) {
    let safe = escapeHtml(text);
    safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/(^|\n)\* (.+)/g, "$1• $2");
    return safe;
  }

  function addMessage(role, text) {
    if (intro && !intro.dataset.hidden) {
      intro.style.display = "none";
      intro.dataset.hidden = "true";
    }
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = role === "user" ? "Toi" : "Piquant";
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    if (role === "assistant") {
      bubble.innerHTML = renderFormatted(text);
    } else {
      bubble.textContent = text;
    }
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    document.querySelector(".stage").scrollTo({ top: 999999, behavior: "smooth" });
    return bubble;
  }

  function addThinking() {
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    wrap.id = "thinkingMsg";
    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = "Piquant";
    const dots = document.createElement("div");
    dots.className = "thinking";
    dots.innerHTML = "<span></span><span></span><span></span><span></span><span></span>";
    wrap.appendChild(label);
    wrap.appendChild(dots);
    thread.appendChild(wrap);
    document.querySelector(".stage").scrollTo({ top: 999999, behavior: "smooth" });
  }

  function removeThinking() {
    const el = document.getElementById("thinkingMsg");
    if (el) el.remove();
  }

  async function sendMessage(text) {
    if (busy || !text.trim()) return;
    busy = true;
    sendBtn.disabled = true;

    addMessage("user", text);
    input.value = "";
    autoGrow();
    addThinking();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });
      const data = await res.json();
      removeThinking();

      if (!res.ok) {
        const bubble = addMessage("assistant", data.error || "Une erreur est survenue.");
        bubble.parentElement.classList.add("error");
      } else {
        addMessage("assistant", data.reply);
      }
    } catch (err) {
      removeThinking();
      const bubble = addMessage(
        "assistant",
        "Impossible de contacter le serveur. Vérifie ta connexion et réessaie."
      );
      bubble.parentElement.classList.add("error");
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      input.value = chip.dataset.prompt;
      autoGrow();
      input.focus();
    });
  });

  resetBtn.addEventListener("click", async () => {
    thread.innerHTML = "";
    if (intro) {
      intro.style.display = "";
      delete intro.dataset.hidden;
    }
    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch (_) {}
  });
})();
