const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const googleTTS = require("google-tts-api");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// Groq est utilisé pour tout le texte (chat + contenu des PDF) : gratuit et sans
// limite bloquante.
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "openai/gpt-oss-20b";

// Images : on essaie d'abord Nano Banana (Gemini), meilleure qualité, puis on
// bascule automatiquement sur Pollinations.ai (gratuit, sans clé) si Gemini
// est indisponible ou si sa limite gratuite est atteinte.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ---------- Base de données (historique des conversations) ----------
// Utilise Postgres (ex: Neon, gratuit) via la variable d'environnement
// DATABASE_URL. Si elle n'est pas définie, le site continue de fonctionner
// normalement mais sans historique persistant (juste la mémoire courte du
// serveur pendant qu'il tourne).
const DATABASE_URL = process.env.DATABASE_URL || "";
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) {
    console.warn(
      "DATABASE_URL non configurée : l'historique des conversations ne sera pas sauvegardé."
    );
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Nouvelle conversation',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON conversations(visitor_id);`);
  console.log("Base de données prête (historique des conversations activé).");
}
initDb().catch((err) => console.error("Erreur d'initialisation de la base :", err));

async function ensureConversation(conversationId, visitorId, firstMessage) {
  if (!pool) return conversationId || crypto.randomUUID();
  const id = conversationId || crypto.randomUUID();
  const title = (firstMessage || "Nouvelle conversation").trim().slice(0, 60) || "Nouvelle conversation";
  await pool.query(
    `INSERT INTO conversations (id, visitor_id, title) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, visitorId || "anonyme", title]
  );
  return id;
}

async function saveMessage(conversationId, role, content) {
  if (!pool || !conversationId) return;
  try {
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
      [conversationId, role, content]
    );
    await pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  } catch (err) {
    console.error("Erreur de sauvegarde du message :", err);
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory conversation context per conversation id (accélère les échanges
// pendant que le serveur tourne ; la base de données garde l'historique complet)
const sessions = new Map();
const MAX_TURNS = 12; // how many past exchanges we keep per session

// Generated PDFs / audio clips, kept in memory just long enough to be downloaded
const pdfStore = new Map();
const audioStore = new Map();

// ---------- Visitor memory (name), persisted to a small JSON file ----------
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
    "dessin", // couvre "dessine", "dessiner", "dessinez", et la faute "dessin moi"
    "génère une photo", "genere une photo", "crée une photo", "cree une photo",
    "photo de", "image de", "illustration de", "génère-moi une image", "fais une image",
    "fais-moi une image", "peux-tu dessiner", "peux tu dessiner", "dessine-moi", "dessine moi",
    "montre-moi une image", "montre moi une image", "affiche une image",
  ];
  if (pdfKeywords.some((k) => lower.includes(k))) return "pdf";
  if (imageKeywords.some((k) => lower.includes(k))) return "image";
  return "text";
}

// ---------- Historique des conversations (menu latéral) ----------
app.get("/api/conversations", async (req, res) => {
  try {
    if (!pool) return res.json({ conversations: [] });
    const { visitorId } = req.query;
    if (!visitorId) return res.json({ conversations: [] });
    const { rows } = await pool.query(
      `SELECT id, title, updated_at FROM conversations WHERE visitor_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [visitorId]
    );
    res.json({ conversations: rows });
  } catch (err) {
    console.error("Erreur de récupération des conversations:", err);
    res.status(500).json({ conversations: [] });
  }
});

app.get("/api/conversations/:id/messages", async (req, res) => {
  try {
    if (!pool) return res.json({ messages: [] });
    const { rows } = await pool.query(
      `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id ASC`,
      [req.params.id]
    );
    res.json({ messages: rows });
  } catch (err) {
    console.error("Erreur de récupération des messages:", err);
    res.status(500).json({ messages: [] });
  }
});

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    if (!pool) return res.json({ ok: true });
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erreur de suppression:", err);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, visitorId } = req.body || {};
    let { conversationId } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message vide." });
    }

    conversationId = await ensureConversation(conversationId, visitorId, message);

    const sid = conversationId;
    if (!sessions.has(sid)) sessions.set(sid, []);
    const history = sessions.get(sid);

    const detectedName = extractNameFromMessage(message);
    if (detectedName) setVisitorName(visitorId || sid, detectedName);

    await saveMessage(conversationId, "user", message);

    const intent = detectIntent(message);

    if (intent === "image") {
      return await handleImageRequest(message, history, res, conversationId);
    }
    if (intent === "pdf") {
      return await handlePdfRequest(message, history, res, conversationId);
    }
    return await handleTextRequest(message, history, res, sid, conversationId, visitorId);
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

const FALLBACK_REPLY = "Je suis là ! 😊 Il y a un petit souci de mon côté en ce moment — reformule ta question ou réessaie dans quelques secondes.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function handleTextRequest(message, history, res, sid, conversationId, visitorId) {
  history.push({ role: "user", parts: [{ text: message }] });
  while (history.length > MAX_TURNS * 2) history.shift();

  if (!GROQ_API_KEY) {
    const reply =
      "Aucune clé API n'est configurée sur le serveur. Ajoute GROQ_API_KEY dans les variables d'environnement de Render.";
    history.push({ role: "model", parts: [{ text: reply }] });
    return res.json({ type: "text", reply, conversationId });
  }

  const { todayLabel, timeLabel } = nowLabels();
  const visitorName = getVisitorName(visitorId || sid);
  const nameLine = visitorName ? ` Le visiteur s'appelle ${visitorName} — adresse-toi à lui par son prénom quand c'est naturel.` : "";

  const systemText =
    `Tu es Piquant, un assistant IA au ton posé, direct et raffiné — pas robotique, pas bavard. ` +
    `Style : phrases courtes et précises, vocabulaire soigné sans être pompeux, jamais de flatterie ni de formules creuses ("excellente question", "je suis ravi de vous aider"). Va droit au fait dès la première phrase. ` +
    `Structure tes réponses avec des paragraphes courts ou des listes quand c'est utile, jamais pour faire joli. Si un sujet est incertain ou débattu, dis-le clairement plutôt que d'inventer une certitude. ` +
    `Réponds dans la langue du visiteur. Sois concis mais complet. ` +
    `Nous sommes aujourd'hui le ${todayLabel}, il est environ ${timeLabel} (heure du Bénin, UTC+1). Utilise cette date réelle si on te demande la date, l'heure ou le jour — ne l'invente jamais. ` +
    `Si on te demande qui t'a créé, qui est ton créateur/développeur, ou qui a fait ce site, réponds que c'est Rahim Batchabi. ` +
    `Si on te demande qui est l'actuel président du Bénin, réponds que c'est Romuald Wadagni, en fonction depuis le 24 mai 2026. ` +
    `Quand tu mentionnes un lien ou un site web, écris-le au format Markdown [texte du lien](https://url-complète.com) pour qu'il s'affiche cliquable. ` +
    `Tu ne sais pas générer de vraies images toi-même dans le texte : si quelqu'un te demande un dessin, une image ou une photo, ne fais jamais de dessin en ASCII/texte à la place — dis-lui simplement de reformuler sa demande en commençant par "Dessine-moi..." ou "Génère une image de...".` +
    nameLine;

  const { response, data } = await callGroqWithRetry(historyToGroqMessages(history, systemText));

  if (!response.ok) {
    console.error("Groq API error:", data);
    history.push({ role: "model", parts: [{ text: FALLBACK_REPLY }] });
    await saveMessage(conversationId, "model", FALLBACK_REPLY);
    return res.json({ type: "text", reply: FALLBACK_REPLY, conversationId });
  }

  const reply = data?.choices?.[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse.";

  history.push({ role: "model", parts: [{ text: reply }] });
  await saveMessage(conversationId, "model", reply);
  res.json({ type: "text", reply, conversationId });
}

async function tryGeminiImage(message) {
  if (!GEMINI_API_KEY) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: message }] }] }),
    });
    if (!response.ok) {
      console.warn("Nano Banana indisponible (statut " + response.status + "), bascule sur Pollinations.");
      return null;
    }
    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData);
    if (!imagePart) return null;
    return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
  } catch (err) {
    console.warn("Erreur Nano Banana, bascule sur Pollinations :", err.message);
    return null;
  }
}

async function tryPollinationsImage(message) {
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(message)}?width=1024&height=1024&nologo=true&model=flux`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const contentType = response.headers.get("content-type") || "image/jpeg";
    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.error("Erreur Pollinations :", err.message);
    return null;
  }
}

async function handleImageRequest(message, history, res, conversationId) {
  // Priorité à Nano Banana (meilleure qualité), puis repli automatique sur
  // Pollinations si la clé manque, si la limite gratuite est atteinte, ou en
  // cas d'erreur quelconque — le visiteur ne voit jamais l'échec intermédiaire.
  let dataUrl = await tryGeminiImage(message);
  if (!dataUrl) dataUrl = await tryPollinationsImage(message);

  if (!dataUrl) {
    return res.status(502).json({
      error: "Impossible de générer l'image pour le moment. Réessaie dans un instant.",
    });
  }

  history.push({ role: "user", parts: [{ text: message }] });
  history.push({ role: "model", parts: [{ text: "[Image générée]" }] });
  while (history.length > MAX_TURNS * 2) history.shift();

  await saveMessage(conversationId, "model", "[Image générée]");

  res.json({
    type: "image",
    reply: "Voici l'image générée :",
    image: dataUrl,
    conversationId,
  });
}

async function handlePdfRequest(message, history, res, conversationId) {
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
    setTimeout(() => pdfStore.delete(id), 15 * 60 * 1000);

    history.push({ role: "user", parts: [{ text: message }] });
    history.push({ role: "model", parts: [{ text: "[Document PDF généré]" }] });
    while (history.length > MAX_TURNS * 2) history.shift();

    saveMessage(conversationId, "model", "[Document PDF généré]");

    res.json({
      type: "pdf",
      reply: "Voici ton document, prêt à télécharger :",
      pdfUrl: `/api/download/${id}.pdf`,
      conversationId,
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
  const clean = text.slice(0, 600);
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
