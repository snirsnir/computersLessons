// ===== ממונה הסוד — Cloudflare Worker: פרוקסי חינמי ל-Google Gemini =====
// הגדרה חד-פעמית:
//   1. ב-Cloudflare → Workers & Pages → Create → Worker. מדביקים את כל הקובץ הזה ל-"Edit code" ו-Deploy.
//   2. ב-Worker → Settings → Variables and Secrets → Add → Secret בשם  GEMINI_KEY  עם מפתח Gemini החינמי (מ-aistudio.google.com/apikey).
//   3. מעתיקים את כתובת ה-Worker (…​.workers.dev) ומדביקים בפאנל המדריך/ה במשחק (או שולחים לי ואטמיע בדף).
// המפתח נשאר בצד השרת בלבד — הילדים לא נרשמים לכלום.

const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const key = env.GEMINI_KEY;
    if (!key) return json({ error: "missing GEMINI_KEY secret" }, 500);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // ממירים את הפורמט שלנו (system/user/assistant) לפורמט של Gemini
    let system = "";
    const contents = [];
    for (const m of messages) {
      if (m.role === "system") system += (system ? "\n" : "") + (m.content || "");
      else contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content || "") }] });
    }

    const payload = {
      contents,
      generationConfig: { temperature: 0.85, maxOutputTokens: 400 },
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT",
      ].map(c => ({ category: c, threshold: "BLOCK_ONLY_HIGH" })),
    };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };

    let lastErr = "";
    for (const model of MODELS) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        );
        if (!resp.ok) {
          lastErr = `${model}:${resp.status}`;
          if (resp.status === 429 || resp.status === 404 || resp.status >= 500) continue; // ננסה מודל הבא
          const t = await resp.text();
          return json({ error: "gemini", detail: t.slice(0, 300) }, 502);
        }
        const data = await resp.json();
        const cand = data.candidates && data.candidates[0];
        const text = cand && cand.content && cand.content.parts
          ? cand.content.parts.map(p => p.text || "").join("")
          : "";
        if (text.trim()) return json({ text: text.trim() }, 200);
        // נחסם ע"י מסנן הבטיחות או ריק — מחזירים סירוב נעים בתוך הדמות
        return json({ text: "אני רק ממונה הסוד הכיפי — בוא נישאר במשחק 🙂" }, 200);
      } catch (e) { lastErr = String(e); }
    }
    return json({ error: "all models failed", detail: lastErr }, 502);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
