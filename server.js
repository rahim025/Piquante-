const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const googleTTS = require("google-tts-api");

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const IMAGE_MODEL = "gemini-3.1-flash-image";

// Groq est utilisé pour tout le texte (chat + contenu des PDF) : gratuit et sans
// la limite qui posait problème avec Gemini. Seule la génération d'images reste
// sur Gemini, car Groq ne sait pas générer d'images.
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "openai/gpt-oss-20b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory conversation history per session id (kept simple, no database)
const sessions = new Map();
const MAX_TURNS = 12; // how many past exchanges we keep per session

// Generated PDFs / audio clips, kept in memory just long enough to be downloaded
const pdfStore = new Map();
const audioStore = new Map();

// ---------- Visitor memory (name), persisted to a small JSON file ----------
// Note: on Render's free tier this file lives on ephemeral disk — it survives
// while the service stays up, but resets on redeploy. Good enough to
// remember a visitor's name during a session/day; not a permanent database.
const VISITOR_FILE = path.join(__dirname, "visitor_memory.json");

function loadVisitorDB() {
  try {
    if (!fs.existsSync(VISITOR_FILE)) return {};
    return JSON.parse(fs.readFileSync(VISITOR_FILE, "utf-8") || "{}");
  } catch {
    return {};
  }
}

function saveVisitorDB(db) {
  try {
    fs.writeFileSync(VISITOR_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("Could not save visitor memory:", err);
  }
}

function getVisitorName(sid) {
  const db = loadVisitorDB();
  return db[sid]?.name || null;
}

function setVisitorName(sid, name) {
  const db = loadVisitorDB();
  db[sid] = { ...(db[sid] || {}), name, lastSeen: Date.now() };
  saveVisitorDB(db);
}

function extractNameFromMessage(message) {
  const patterns = [/je m'appelle\s+(.+)/i, /mon nom est\s+(.+)/i];
  for (const re of patterns) {
    const match = message.match(re);
    if (match && match[1]) {
      return match[1].trim().replace(/[.!?]+$/, "").slice(0, 40);
    }
  }
  return null;
}

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
    const { message, sessionId } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message vide." });
    }
    const sid = typeof sessionId === "string" && sessionId ? sessionId : "default";
    if (!sessions.has(sid)) sessions.set(sid, []);
    const history = sessions.get(sid);

    const detectedName = extractNameFromMessage(message);
    if (detectedName) setVisitorName(sid, detectedName);

    const intent = detectIntent(message);

    if (intent === "image") {
      return await handleImageRequest(message, history, res);
    }
    if (intent === "pdf") {
      return await handlePdfRequest(message, history, res);
    }
    return await handleTextRequest(message, history, res, sid);
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

const FALLBACK_REPLY = "Je suis là ! 😊 Il y a un petit souci de mon côté en ce moment — reformule ta question ou réessaie dans quelques secondes.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls the Gemini API, retrying automatically on rate limits (429) or
// temporary server errors (5xx) so a busy moment doesn't just fail outright.
async function callGeminiWithRetry(url, body, { retries = 2, baseDelay = 2000 } = {}) {
  let lastResponse, lastData;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    if (response.ok) return { response, data };

    lastResponse = response;
    lastData = data;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retries) break;

    await sleep(baseDelay * (attempt + 1));
  }
  return { response: lastResponse, data: lastData };
}

// Calls Groq's OpenAI-compatible chat completions endpoint, retrying on
// rate limits (429) or temporary server errors (5xx).
async function callGroqWithRetry(messages, { retries = 2, baseDelay = 2000 } = {}) {
  let lastResponse, lastData;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 800,
      }),
    });
    const data = await response.json();

    if (response.ok) return { response, data };

    lastResponse = response;
    lastData = data;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retries) break;

    await sleep(baseDelay * (attempt + 1));
  }
  return { response: lastResponse, data: lastData };
}

// Converts our Gemini-style history ({role, parts:[{text}]}) into the
// OpenAI-style messages array Groq expects ({role, content}).
function historyToGroqMessages(history, systemText) {
  const messages = [{ role: "system", content: systemText }];
  for (const turn of history) {
    messages.push({
      role: turn.role === "model" ? "assistant" : "user",
      content: (turn.parts || []).map((p) => p.text).join(""),
    });
  }
  return messages;
}

async function handleTextRequest(message, history, res, sid) {
  history.push({ role: "user", parts: [{ text: message }] });
  while (history.length > MAX_TURNS * 2) history.shift();

  if (!GROQ_API_KEY) {
    const reply =
      "Aucune clé API n'est configurée sur le serveur. Ajoute GROQ_API_KEY dans les variables d'environnement de Render.";
    history.push({ role: "model", parts: [{ text: reply }] });
    return res.json({ type: "text", reply });
  }

  const { todayLabel, timeLabel } = nowLabels();
  const visitorName = sid ? getVisitorName(sid) : null;
  const nameLine = visitorName ? ` Le visiteur s'appelle ${visitorName} — adresse-toi à lui par son prénom quand c'est naturel.` : "";

  const systemText =
    `Tu es un assistant IA utile, chaleureux et clair, qui répond aux visiteurs d'un site web. Réponds dans la langue du visiteur. Sois concis mais complet. ` +
    `Nous sommes aujourd'hui le ${todayLabel}, il est environ ${timeLabel} (heure du Bénin, UTC+1). Utilise cette date réelle si on te demande la date, l'heure ou le jour — ne l'invente jamais.` +
    nameLine;

  const { response, data } = await callGroqWithRetry(historyToGroqMessages(history, systemText));

  if (!response.ok) {
    console.error("Groq API error:", data);
    // After retries, don't dead-end the visitor with a raw error — respond warmly instead.
    history.push({ role: "model", parts: [{ text: FALLBACK_REPLY }] });
    return res.json({ type: "text", reply: FALLBACK_REPLY });
  }

  const reply = data?.choices?.[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse.";

  history.push({ role: "model", parts: [{ text: reply }] });
  res.json({ type: "text", reply });
}

async function handleImageRequest(message, history, res) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const { response, data } = await callGeminiWithRetry(url, {
    contents: [{ role: "user", parts: [{ text: message }] }],
  });

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
  if (!GROQ_API_KEY) {
    return res.status(500).json({
      error: "Aucune clé API n'est configurée sur le serveur. Ajoute GROQ_API_KEY dans les variables d'environnement.",
    });
  }

  const { todayLabel, timeLabel } = nowLabels();
  const systemText =
    `Tu es un assistant qui rédige le contenu d'un document PDF demandé par un visiteur d'un site web. ` +
    `Rédige uniquement le contenu du document (pas de phrase du type "voici le contenu"), structuré avec des titres clairs si utile. ` +
    `Réponds dans la langue du visiteur. Nous sommes le ${todayLabel}, ${timeLabel} (heure du Bénin).`;

  const { response, data } = await callGroqWithRetry([
    { role: "system", content: systemText },
    { role: "user", content: message },
  ]);

  if (!response.ok) {
    console.error("Groq API error:", data);
    return res.status(response.status === 429 ? 429 : 502).json({
      error:
        response.status === 429
          ? "Il y a trop de demandes en ce moment (limite gratuite atteinte). Réessaie dans une minute."
          : data?.error?.message || "Erreur lors de l'appel à l'IA.",
    });
  }

  const content = data?.choices?.[0]?.message?.content || "Contenu indisponible.";

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

// ---------- Voice: read a message aloud ----------
async function synthesizeSpeech(text) {
  const clean = text.slice(0, 600); // keep clips reasonably short
  const urls = googleTTS.getAllAudioUrls(clean, {
    lang: "fr",
    slow: false,
    host: "https://translate.google.com",
  });

  const buffers = [];
  for (const { url } of urls) {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!r.ok) throw new Error("Échec de la synthèse vocale.");
    buffers.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(buffers);
}

app.post("/api/speak", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Texte vide." });
    }
    const audioBuffer = await synthesizeSpeech(text);
    const id = crypto.randomUUID();
    audioStore.set(id, audioBuffer);
    setTimeout(() => audioStore.delete(id), 15 * 60 * 1000);
    res.json({ audioUrl: `/api/audio/${id}.mp3` });
  } catch (err) {
    console.error("TTS error:", err);
    res.status(502).json({ error: "Impossible de générer la voix pour ce message." });
  }
});

app.get("/api/audio/:id.mp3", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).send("Audio introuvable ou expiré.");
  res.setHeader("Content-Type", "audio/mpeg");
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
