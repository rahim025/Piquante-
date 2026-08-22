# Piquant — site d'assistant IA

Un site de chat façon ChatGPT/Claude, propulsé par l'API Gemini de Google.

## Structure

- `server.js` — petit serveur Express qui sert le site et appelle Gemini (ta clé API reste secrète, côté serveur)
- `public/` — la page web (HTML/CSS/JS)

## Déployer sur Render (gratuit)

1. Crée un compte sur https://render.com
2. Mets ce dossier dans un dépôt GitHub (ou upload direct si Render le propose)
3. Sur Render : **New +** → **Web Service** → connecte ton dépôt
4. Render détecte Node.js automatiquement. Renseigne :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
5. Dans l'onglet **Environment**, ajoute une variable :
   - **Key** : `GEMINI_API_KEY`
   - **Value** : ta clé API (celle obtenue sur aistudio.google.com/apikey)
6. Clique **Create Web Service**. Après quelques minutes, ton site sera en ligne à une adresse du type `https://ton-site.onrender.com`

## Tester en local (optionnel, si tu as Node.js installé)

```
npm install
set GEMINI_API_KEY=ta_cle_ici   (Windows)
export GEMINI_API_KEY=ta_cle_ici (Mac/Linux)
npm start
```

Puis ouvre http://localhost:3000

## Notes

- L'historique de conversation est gardé en mémoire le temps que le serveur tourne (pas de base de données pour l'instant).
- Le modèle utilisé est `gemini-2.5-flash` (rapide et gratuit dans les limites du quota Google).
