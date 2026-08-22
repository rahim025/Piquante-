const express = require("express");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-3.6-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory conversation history per session id (kept simple, no database)
const sessions = new Map();
const MAX_TURNS = 12; // how many past exchanges we keep per session

// Generated PDFs, kept in memory just long enough to be downloaded
const pdfStore = new Map();

function detectIntent(message) {
  const lower = message.toLowerCase();
  const pdfKeywords = ["pdf", "fichier pdf", "document pdf", "en pdf"];
  const imageKeywords = [
    "génère une image", "genere une image", "crée une image", "cree une image",
    "dessine", "génère une photo", "genere une photo", "crée une photo", "cree une photo",
    "photo de", "image de", "illustration de", "génère-moi une image", "fais une image",
    "fais-moi une image", "peux-tu dessiner", "peux tu dessiner",
  ];
  if (pdfKeywords.some((k) => lower.includes(k))) return "pdf";
  if (imageKeywords.some((k) => lower.includes(k))) return "image";
  return "text";
}

app.post("/api/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error:
          "Aucune clé API n'est configurée sur le serveur. Ajoute GEMINI_API_KEY dans les variables d'environnement.",
      });
    }

    const { message, sessionId } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message vide." });
    }
    const sid = typeof sessionId === "string" && sessionId ? sessionId : "default";
    if (!sessions.has(sid)) sessions.set(sid, []);
    const history = sessions.get(sid);

    const intent = detectIntent(message);

    if (intent === "image") {
      return await handleImageRequest(message, history, res);
    }
    if (intent === "pdf") {
      return await handlePdfRequest(message, history, res);
    }
    return await handleTextRequest(message, history, res);
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

function nowLabels() {
  const now = new Date();
  const todayLabel = now.toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Africa/Porto-Novo",
  });
  const timeLabel = now.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Porto-Novo",
  });
  return { todayLabel, timeLabel };
}

function friendlyApiError(response, data) {
  if (response.status === 429) {
    return "Il y a trop de demandes en ce moment (limite gratuite atteinte). Réessaie dans une minute.";
  }
  return data?.error?.message || "Erreur lors de l'appel à l'IA.";
}

async function handleTextRequest(message, history, res) {
  history.push({ role: "user", parts: [{ text: message }] });
  while (history.length > MAX_TURNS * 2) history.shift();

  const { todayLabel, timeLabel } = nowLabels();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: history,
      systemInstruction: {
        parts: [
          {
            text:
              `Tu es un assistant IA utile, chaleureux et clair, qui répond aux visiteurs d'un site web. Réponds dans la langue du visiteur. Sois concis mais complet. ` +
              `Nous sommes aujourd'hui le ${todayLabel}, il est environ ${timeLabel} (heure du Bénin, UTC+1). Utilise cette date réelle si on te demande la date, l'heure ou le jour — ne l'invente jamais.`,
          },
        ],
      },
      generationConfig: { maxOutputTokens: 800, temperature: 0.7 },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini API error:", data);
    return res.status(response.status === 429 ? 429 : 502).json({ error: friendlyApiError(response, data) });
  }

  const reply =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    "Désolé, je n'ai pas pu générer de réponse.";

  history.push({ role: "model", parts: [{ text: reply }] });
  res.json({ type: "text", reply });
}

async function handleImageRequest(message, history, res) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: message }] }],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini image API error:", data);
    return res.status(response.status === 429 ? 429 : 502).json({ error: friendlyApiError(response, data) });
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData);
  const textPart = parts.find((p) => p.text);

  if (!imagePart) {
    return res.status(502).json({
      error: "L'IA n'a pas pu générer d'image pour cette demande (essaie de reformuler).",
    });
  }

  const dataUrl = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;

  history.push({ role: "user", parts: [{ text: message }] });
  history.push({ role: "model", parts: [{ text: "[Image générée]" }] });
  while (history.length > MAX_TURNS * 2) history.shift();

  res.json({
    type: "image",
    reply: textPart?.text || "Voici l'image générée :",
    image: dataUrl,
  });
}

async function handlePdfRequest(message, history, res) {
  const { todayLabel, timeLabel } = nowLabels();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: message }] }],
      systemInstruction: {
        parts: [
          {
            text:
              `Tu es un assistant qui rédige le contenu d'un document PDF demandé par un visiteur d'un site web. ` +
              `Rédige uniquement le contenu du document (pas de phrase du type "voici le contenu"), structuré avec des titres clairs si utile. ` +
              `Réponds dans la langue du visiteur. Nous sommes le ${todayLabel}, ${timeLabel} (heure du Bénin).`,
          },
        ],
      },
      generationConfig: { maxOutputTokens: 1500, temperature: 0.6 },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini API error:", data);
    return res.status(response.status === 429 ? 429 : 502).json({ error: friendlyApiError(response, data) });
  }

  const content =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    "Contenu indisponible.";

  const id = crypto.randomUUID();
  const buffers = [];
  const doc = new PDFDocument({ margin: 50 });
  doc.on("data", (chunk) => buffers.push(chunk));
  doc.on("end", () => {
    pdfStore.set(id, Buffer.concat(buffers));
    // free memory after 15 minutes if never downloaded
    setTimeout(() => pdfStore.delete(id), 15 * 60 * 1000);

    history.push({ role: "user", parts: [{ text: message }] });
    history.push({ role: "model", parts: [{ text: "[Document PDF généré]" }] });
    while (history.length > MAX_TURNS * 2) history.shift();

    res.json({
      type: "pdf",
      reply: "Voici ton document, prêt à télécharger :",
      pdfUrl: `/api/download/${id}.pdf`,
    });
  });

  doc.font("Helvetica").fontSize(12).text(content, { align: "left" });
  doc.end();
}

app.get("/api/download/:id.pdf", (req, res) => {
  const buf = pdfStore.get(req.params.id);
  if (!buf) return res.status(404).send("Document introuvable ou expiré.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="document.pdf"`);
  res.send(buf);
});

app.post("/api/reset", (req, res) => {
  const { sessionId } = req.body || {};
  const sid = typeof sessionId === "string" && sessionId ? sessionId : "default";
  sessions.delete(sid);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
