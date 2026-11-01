// ===== ממונה הסוד — Cloudflare Worker: פרוקסי חינמי ל-Google Gemini =====
// הגדרה: Settings → Variables and Secrets → Add → Secret בשם GEMINI_KEY (מפתח מ-aistudio.google.com/apikey).
// הדף שולח {messages:[{role,content}]} ומקבל {text}. המפתח נשאר בצד השרת בלבד.
// GET על הכתובת מחזיר את רשימת המודלים הזמינים (לאבחון).

const API = "https://generativelanguage.googleapis.com/v1beta";
// העדפה (מהיר קודם); אם לא זמינים, ה-Worker מגלה אוטומטית מה כן זמין למפתח.
const PREFERRED = ["gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const key = env.GEMINI_KEY;
    if (!key) return json({ error: "missing GEMINI_KEY secret" }, 500);

    // GET → אבחון: אילו מודלים זמינים
    if (request.method === "GET") return json({ models: await listModels(key) }, 200);
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // המרה לפורמט של Gemini
    let system = "";
    const contents = [];
    for (const m of messages) {
      if (m.role === "system") system += (system ? "\n" : "") + (m.content || "");
      else contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content || "") }] });
    }
    const payload = {
      contents,
      // thinkingBudget:0 מכבה "חשיבה" → תשובות מהירות וקצרות (קריטי למשחק בזמן אמת)
      generationConfig: { temperature: 0.85, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT",
      ].map(c => ({ category: c, threshold: "BLOCK_ONLY_HIGH" })),
    };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    // גרסה ללא thinkingConfig, למקרה שמודל מסוים לא תומך בו (מחזיר 400)
    const payloadNoThink = { ...payload, generationConfig: { temperature: 0.85, maxOutputTokens: 500 } };

    let candidates = PREFERRED.slice();
    let discovered = false;
    let lastErr = "";
    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      try {
        let resp = await fetch(`${API}/models/${model}:generateContent?key=${key}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (resp.status === 400) { // המודל לא אהב את thinkingConfig — ננסה בלעדיו
          resp = await fetch(`${API}/models/${model}:generateContent?key=${key}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadNoThink),
          });
        }
        if (resp.ok) {
          const data = await resp.json();
          const cand = data.candidates && data.candidates[0];
          const text = cand && cand.content && cand.content.parts
            ? cand.content.parts.map(p => p.text || "").join("") : "";
          if (text.trim()) return json({ text: text.trim() }, 200);
          return json({ text: "אני רק ממונה הסוד הכיפי — בוא נישאר במשחק 🙂" }, 200);
        }
        lastErr = `${model}:${resp.status}`;
        // מודל לא נמצא → נגלה פעם אחת מה באמת זמין ונחליף את הרשימה
        if (resp.status === 404 && !discovered) {
          const avail = await listModels(key);
          if (avail.length) { candidates = avail; discovered = true; i = -1; continue; }
        }
        if (resp.status === 429 || resp.status === 404 || resp.status >= 500) continue; // ננסה הבא
        const t = await resp.text();
        return json({ error: "gemini", detail: t.slice(0, 300) }, 502);
      } catch (e) { lastErr = String(e); }
    }
    return json({ error: "all models failed", detail: lastErr }, 502);
  },
};

// רשימת מודלים שתומכים ב-generateContent, ממוינת כך ש-flash קודם (מהיר/חינמי)
async function listModels(key) {
  try {
    const r = await fetch(`${API}/models?key=${key}&pageSize=200`);
    if (!r.ok) return [];
    const d = await r.json();
    const names = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""))
      .filter(n => !/vision|embedding|aqa|image|tts|audio/i.test(n));
    const score = n => (/flash-lite/.test(n) ? 0 : /flash/.test(n) ? 1 : /pro/.test(n) ? 3 : 2) + (/latest/.test(n) ? -0.5 : 0);
    return names.sort((a, b) => score(a) - score(b));
  } catch { return []; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
