(() => {
  const intro = document.getElementById("intro");
  const thread = document.getElementById("thread");
  const form = document.getElementById("composerForm");
  const input = document.getElementById("composerInput");
  const sendBtn = document.getElementById("sendBtn");
  const resetBtn = document.getElementById("resetBtn");
  const attachBtn = document.getElementById("attachBtn");
  const fileInput = document.getElementById("fileInput");
  const filePreviewRow = document.getElementById("filePreviewRow");

  let pendingFile = null; // { name, mimeType, data (base64 sans préfixe), previewUrl }

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // permet de resélectionner le même fichier plus tard
    if (!file) return;

    const MAX_SIZE = 8 * 1024 * 1024; // 8 Mo
    if (file.size > MAX_SIZE) {
      alert("Ce fichier est trop volumineux (8 Mo maximum).");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      pendingFile = {
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        data: base64,
        previewUrl: file.type.startsWith("image/") ? dataUrl : null,
      };
      renderFilePreview();
    };
    reader.readAsDataURL(file);
  });

  function renderFilePreview() {
    if (!pendingFile) {
      filePreviewRow.style.display = "none";
      filePreviewRow.innerHTML = "";
      return;
    }
    filePreviewRow.style.display = "flex";
    filePreviewRow.innerHTML = "";
    const chip = document.createElement("div");
    chip.className = "file-preview-chip";
    if (pendingFile.previewUrl) {
      const img = document.createElement("img");
      img.src = pendingFile.previewUrl;
      chip.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "fpc-name";
    name.textContent = pendingFile.name;
    chip.appendChild(name);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "fpc-remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      pendingFile = null;
      renderFilePreview();
    });
    chip.appendChild(removeBtn);
    filePreviewRow.appendChild(chip);
  }

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

    // Liens au format Markdown : [texte](https://exemple.com)
    safe = safe.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // URLs brutes restantes (non déjà transformées en <a>)
    safe = safe.replace(
      /(^|[^"'>])(https?:\/\/[^\s<]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
    );

    return safe;
  }

  let currentAudio = null;

  async function playSpeech(text, btn) {
    if (btn.dataset.loading === "1") return;
    try {
      btn.dataset.loading = "1";
      btn.textContent = "⏳";
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur audio");

      if (currentAudio) currentAudio.pause();
      currentAudio = new Audio(data.audioUrl);
      btn.textContent = "🔊";
      currentAudio.play();
      currentAudio.onended = () => {
        btn.textContent = "🔈";
      };
    } catch (err) {
      btn.textContent = "🔈";
      console.error(err);
    } finally {
      btn.dataset.loading = "0";
    }
  }

  function addMessage(role, text, attachment) {
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

    if (attachment) {
      if (attachment.previewUrl) {
        const img = document.createElement("img");
        img.src = attachment.previewUrl;
        img.className = "msg-attachment-img";
        img.alt = attachment.name;
        bubble.appendChild(img);
      } else {
        const fileTag = document.createElement("div");
        fileTag.className = "msg-attachment-file";
        fileTag.textContent = `📎 ${attachment.name}`;
        bubble.appendChild(fileTag);
      }
    }

    wrap.appendChild(label);
    wrap.appendChild(bubble);

    if (role === "assistant") {
      const speakBtn = document.createElement("button");
      speakBtn.type = "button";
      speakBtn.className = "speak-btn";
      speakBtn.textContent = "🔈";
      speakBtn.title = "Écouter cette réponse";
      speakBtn.addEventListener("click", () => playSpeech(text, speakBtn));
      wrap.appendChild(speakBtn);
    }

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

  function addImageMessage(text, dataUrl) {
    const bubble = addMessage("assistant", text);
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = "Image générée";
    img.className = "generated-image";
    bubble.appendChild(document.createElement("br"));
    bubble.appendChild(img);
    return bubble;
  }

  function addPdfMessage(text, pdfUrl) {
    const bubble = addMessage("assistant", text);
    const link = document.createElement("a");
    link.href = pdfUrl;
    link.className = "pdf-download";
    link.textContent = "⬇ Télécharger le PDF";
    link.setAttribute("download", "document.pdf");
    bubble.appendChild(document.createElement("br"));
    bubble.appendChild(link);
    return bubble;
  }

  async function sendMessage(text) {
    const fileToSend = pendingFile;
    if (busy || (!text.trim() && !fileToSend)) return;
    busy = true;
    sendBtn.disabled = true;

    addMessage("user", text.trim() || (fileToSend ? `Fichier joint : ${fileToSend.name}` : ""), fileToSend);
    input.value = "";
    autoGrow();
    pendingFile = null;
    renderFilePreview();
    addThinking();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId,
          file: fileToSend
            ? { name: fileToSend.name, mimeType: fileToSend.mimeType, data: fileToSend.data }
            : undefined,
        }),
      });
      const data = await res.json();
      removeThinking();

      if (!res.ok) {
        const bubble = addMessage("assistant", data.error || "Une erreur est survenue.");
        bubble.parentElement.classList.add("error");
      } else if (data.type === "image") {
        addImageMessage(data.reply, data.image);
      } else if (data.type === "pdf") {
        addPdfMessage(data.reply, data.pdfUrl);
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
