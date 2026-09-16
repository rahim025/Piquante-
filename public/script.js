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
  const micBtn = document.getElementById("micBtn");

  const visitorId =
    localStorage.getItem("piquant_visitor") ||
    (() => {
      const id = crypto.randomUUID();
      localStorage.setItem("piquant_visitor", id);
      return id;
    })();
  let conversationId = null;
  let pendingImage = null; // data URL base64 de la photo jointe, ou null

  let busy = false;

  // --- Pièce jointe : photo envoyée à l'IA pour analyse ---
  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("Pour l'instant, seules les photos peuvent être jointes.");
      fileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingImage = e.target.result;
      filePreviewRow.style.display = "flex";
      filePreviewRow.innerHTML = "";
      const chip = document.createElement("div");
      chip.className = "file-preview-chip";
      const thumb = document.createElement("img");
      thumb.src = pendingImage;
      const name = document.createElement("span");
      name.className = "fpc-name";
      name.textContent = file.name;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "fpc-remove";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        pendingImage = null;
        fileInput.value = "";
        filePreviewRow.style.display = "none";
        filePreviewRow.innerHTML = "";
      });
      chip.appendChild(thumb);
      chip.appendChild(name);
      chip.appendChild(removeBtn);
      filePreviewRow.appendChild(chip);
    };
    reader.readAsDataURL(file);
  });

  // --- Question posée par vocal (reconnaissance vocale du navigateur) ---
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let listening = false;

  if (SpeechRecognitionAPI) {
    recognizer = new SpeechRecognitionAPI();
    recognizer.lang = "fr-FR";
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    recognizer.addEventListener("result", (e) => {
      const transcript = e.results[0][0].transcript;
      input.value = (input.value ? input.value + " " : "") + transcript;
      autoGrow();
    });
    recognizer.addEventListener("end", () => {
      listening = false;
      micBtn.classList.remove("mic-active");
    });
    recognizer.addEventListener("error", () => {
      listening = false;
      micBtn.classList.remove("mic-active");
    });

    micBtn.addEventListener("click", () => {
      if (listening) {
        recognizer.stop();
        return;
      }
      try {
        recognizer.start();
        listening = true;
        micBtn.classList.add("mic-active");
      } catch (_) {}
    });
  } else {
    micBtn.addEventListener("click", () => {
      alert("La reconnaissance vocale n'est pas disponible sur ce navigateur. Essaie avec Chrome.");
    });
  }

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

  function addPinterestMessage(text, images) {
    const bubble = addMessage("assistant", text);
    const grid = document.createElement("div");
    grid.className = "pinterest-grid";
    images.forEach((url) => {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "pinterest-thumb";
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Résultat Pinterest";
      img.loading = "lazy";
      img.onerror = () => link.remove();
      link.appendChild(img);
      grid.appendChild(link);
    });
    bubble.appendChild(document.createElement("br"));
    bubble.appendChild(grid);
    return bubble;
  }

  async function sendMessage(text) {
    if (busy || (!text.trim() && !pendingImage)) return;
    busy = true;
    sendBtn.disabled = true;

    const imageToSend = pendingImage;
    addMessage("user", text || "(photo envoyée)");
    if (imageToSend) {
      const lastBubble = thread.lastElementChild.querySelector(".msg-bubble");
      if (lastBubble) {
        const thumb = document.createElement("img");
        thumb.src = imageToSend;
        thumb.className = "sent-photo-thumb";
        lastBubble.appendChild(document.createElement("br"));
        lastBubble.appendChild(thumb);
      }
    }
    input.value = "";
    pendingImage = null;
    fileInput.value = "";
    filePreviewRow.style.display = "none";
    filePreviewRow.innerHTML = "";
    autoGrow();
    addThinking();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, visitorId, conversationId, image: imageToSend }),
      });
      const data = await res.json();
      removeThinking();

      if (data.conversationId) conversationId = data.conversationId;

      if (!res.ok) {
        const bubble = addMessage("assistant", data.error || "Une erreur est survenue.");
        bubble.parentElement.classList.add("error");
      } else if (data.type === "image") {
        addImageMessage(data.reply, data.image);
      } else if (data.type === "pdf") {
        addPdfMessage(data.reply, data.pdfUrl);
      } else if (data.type === "pinterest") {
        addPinterestMessage(data.reply, data.images);
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
    if (input.value.trim() || pendingImage) sendMessage(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.value.trim() || pendingImage) sendMessage(input.value);
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
        body: JSON.stringify({ sessionId: conversationId }),
      });
    } catch (_) {}
    conversationId = null;
  });
})();
