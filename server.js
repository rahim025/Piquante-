const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-3.6-flash";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory conversation history per session id (kept simple, no database)
const sessions = new Map();
const MAX_TURNS = 12; // how many past exchanges we keep per session

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

    history.push({ role: "user", parts: [{ text: message }] });
    while (history.length > MAX_TURNS * 2) history.shift();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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
      return res.status(502).json({
        error: data?.error?.message || "Erreur lors de l'appel à l'IA.",
      });
    }

    const reply =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
      "Désolé, je n'ai pas pu générer de réponse.";

    history.push({ role: "model", parts: [{ text: reply }] });

    res.json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
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
