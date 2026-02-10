import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "innerself-ai", time: new Date().toISOString() });
});

/* ---------- Utils ---------- */
function badRequest(res, message) {
  return res.status(400).json({ error: "Invalid request body", message });
}

/**
 * Robustly extract text from Responses API object.
 * We do NOT rely on output_text (often empty).
 */
function extractTextFromResponses(resp) {
  const out = resp?.output;
  if (!Array.isArray(out)) return "";

  const chunks = [];
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      // Most common: { type: "output_text", text: "..." }
      // Sometimes:   { type: "text", text: "..." }
      if (typeof c?.text === "string" && c.text.trim().length > 0) {
        chunks.push(c.text);
      }
    }
  }
  return chunks.join("").trim();
}

/**
 * If model output includes extra text, try to cut out the first JSON object.
 * This prevents "Unexpected end" when there is trailing non-JSON or leading labels.
 */
function extractFirstJSONObject(raw) {
  const s = (raw ?? "").trim();
  if (!s) return "";

  // If already looks like JSON object, return directly
  if (s.startsWith("{") && s.endsWith("}")) return s;

  // Try find first '{' and last '}' and take that slice
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return s.slice(first, last + 1).trim();
  }
  return "";
}

function parseModelJSON(raw) {
  const s0 = (raw ?? "").trim();
  if (!s0) {
    const err = new Error("EMPTY_MODEL_OUTPUT");
    err.code = "EMPTY_MODEL_OUTPUT";
    throw err;
  }

  const s = extractFirstJSONObject(s0) || s0;

  try {
    return JSON.parse(s);
  } catch (e) {
    const err = new Error("JSON_PARSE_FAILED");
    err.code = "JSON_PARSE_FAILED";
    err.details = e?.message ?? String(e);
    err.preview = s.slice(0, 800);
    throw err;
  }
}

/* ---------- Prompt builders (keep yours; here minimal demo) ---------- */
function buildBasicPrompt({ question, context, mainCards }) {
  const ctx = context && context.trim() ? context.trim() : "null";
  return `
你是 innerSelf App 的「基礎版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

【輸入】
- 使用者問題：${question}
-（可選）既有前提／已選擇的路徑：${ctx}
主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

【規則】
- 嚴格輸出 JSON（單一物件），不得有任何多餘文字。
- cardText 不得改寫。
- actionDirection：15～30 全形字
- possibleOutcome：≤50 全形字
- actionDirection/possibleOutcome 必須同時對應：問題 +（若有）前提 + 牌卡視角

【輸出 JSON Schema】
{
  "version":"basic_v1_json",
  "language":"zh-Hant",
  "question":string,
  "context":string|null,
  "directions":[
    {"id":"A","cardText":string,"actionDirection":string,"possibleOutcome":string},
    {"id":"B","cardText":string,"actionDirection":string,"possibleOutcome":string},
    {"id":"C","cardText":string,"actionDirection":string,"possibleOutcome":string}
  ]
}
`.trim();
}

function buildClearPrompt({ question, context, mainCards, branchCards }) {
  const ctx = context && context.trim() ? context.trim() : "null";
  return `
你是 innerSelf App 的「明晰版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

【輸入】
- 使用者問題：${question}
-（可選）既有前提／已選擇的路徑：${ctx}

主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

子牌：
A-1) ${branchCards[0]}  A-2) ${branchCards[1]}  A-3) ${branchCards[2]}
B-1) ${branchCards[3]}  B-2) ${branchCards[4]}  B-3) ${branchCards[5]}
C-1) ${branchCards[6]}  C-2) ${branchCards[7]}  C-3) ${branchCards[8]}

【規則】
- 嚴格輸出 JSON（單一物件），不得有任何多餘文字。
- cardText 不得改寫。
- 主牌：actionDirection 15～30 全形字；possibleOutcome ≤50 全形字
- 子牌：possibleOutcome ≤50 全形字
- 主牌 actionDirection/possibleOutcome 必須同時對應：問題 +（若有）前提 + 牌卡視角

【輸出 JSON Schema】
{
  "version":"clear_v1_json",
  "language":"zh-Hant",
  "question":string,
  "context":string|null,
  "directions":[
    {"id":"A","cardText":string,"actionDirection":string,"possibleOutcome":string,
     "branches":[
       {"id":"A-1","cardText":string,"possibleOutcome":string},
       {"id":"A-2","cardText":string,"possibleOutcome":string},
       {"id":"A-3","cardText":string,"possibleOutcome":string}
     ]},
    {"id":"B","cardText":string,"actionDirection":string,"possibleOutcome":string,
     "branches":[
       {"id":"B-1","cardText":string,"possibleOutcome":string},
       {"id":"B-2","cardText":string,"possibleOutcome":string},
       {"id":"B-3","cardText":string,"possibleOutcome":string}
     ]},
    {"id":"C","cardText":string,"actionDirection":string,"possibleOutcome":string,
     "branches":[
       {"id":"C-1","cardText":string,"possibleOutcome":string},
       {"id":"C-2","cardText":string,"possibleOutcome":string},
       {"id":"C-3","cardText":string,"possibleOutcome":string}
     ]}
  ]
}
`.trim();
}

/* ---------- Fallbacks (keep yours or minimal) ---------- */
function fallbackBasicResponse({ question, context, mainCards }) {
  return {
    version: "basic_v1_json",
    language: "zh-Hant",
    question,
    context: context ?? null,
    directions: [
      { id: "A", cardText: mainCards[0], actionDirection: "先把注意力拉回可控的一步", possibleOutcome: "焦慮下降，下一步更容易啟動。" },
      { id: "B", cardText: mainCards[1], actionDirection: "用小試探換取更真實的回饋", possibleOutcome: "資訊變多，判斷會更貼近現況。" },
      { id: "C", cardText: mainCards[2], actionDirection: "調整節奏與界線後再往前推", possibleOutcome: "消耗變少，行動更能持續。" },
    ],
  };
}

function fallbackClearResponse({ question, context, mainCards, branchCards }) {
  return {
    version: "clear_v1_json",
    language: "zh-Hant",
    question,
    context: context ?? null,
    directions: [
      {
        id: "A",
        cardText: mainCards[0],
        actionDirection: "先觀察整體狀態再推進",
        possibleOutcome: "方向會逐漸明朗，但仍需時間。",
        branches: [
          { id: "A-1", cardText: branchCards[0], possibleOutcome: "你會察覺目前的限制。" },
          { id: "A-2", cardText: branchCards[1], possibleOutcome: "節奏感會變得清楚。" },
          { id: "A-3", cardText: branchCards[2], possibleOutcome: "你會減少內在拉扯。" },
        ],
      },
      {
        id: "B",
        cardText: mainCards[1],
        actionDirection: "調整資源配置與界線",
        possibleOutcome: "壓力降低，選擇更一致。",
        branches: [
          { id: "B-1", cardText: branchCards[3], possibleOutcome: "你會釐清真正的重點。" },
          { id: "B-2", cardText: branchCards[4], possibleOutcome: "會出現支援的可能。" },
          { id: "B-3", cardText: branchCards[5], possibleOutcome: "你會更安心行動。" },
        ],
      },
      {
        id: "C",
        cardText: mainCards[2],
        actionDirection: "先行動再修正方向",
        possibleOutcome: "進展出現，但需反覆調整。",
        branches: [
          { id: "C-1", cardText: branchCards[6], possibleOutcome: "你會獲得實際回饋。" },
          { id: "C-2", cardText: branchCards[7], possibleOutcome: "假設會被重新檢視。" },
          { id: "C-3", cardText: branchCards[8], possibleOutcome: "下一步逐漸成形。" },
        ],
      },
    ],
  };
}

/* ---------- API: Basic ---------- */
app.post("/ai/three-card/basic", async (req, res) => {
  const { question, context, mainCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) return badRequest(res, "mainCards must be length 3");

  try {
    console.log("➡️ calling OpenAI (basic)");

    const prompt = buildBasicPrompt({ question, context, mainCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      // ✅ JSON mode for Responses API:
      text: { format: { type: "json_object" } },
      // 你說先取消 max token，這裡就先不放
      // max_output_tokens: 800,
    });

    const raw = extractTextFromResponses(ai);
    console.log("✅ OpenAI raw chars (basic):", raw.length);

    // 若 raw 是空的，立刻把 output 結構摘要印出來
    if (!raw) {
      console.log("🔎 OpenAI output summary (basic):", JSON.stringify(ai?.output ?? null).slice(0, 2000));
    }

    const parsed = parseModelJSON(raw);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (basic) => fallback", err?.code ?? err, err?.preview ? `preview=${err.preview}` : "");
    return res.json(fallbackBasicResponse({ question, context, mainCards }));
  }
});

/* ---------- API: Clear ---------- */
app.post("/ai/three-card/clear", async (req, res) => {
  const { question, context, mainCards, branchCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) return badRequest(res, "mainCards must be length 3");
  if (!Array.isArray(branchCards) || branchCards.length !== 9) return badRequest(res, "branchCards must be length 9");

  try {
    console.log("➡️ calling OpenAI (clear)");

    const prompt = buildClearPrompt({ question, context, mainCards, branchCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      text: { format: { type: "json_object" } },
      // max_output_tokens: 1200,
    });

    const raw = extractTextFromResponses(ai);
    console.log("✅ OpenAI raw chars (clear):", raw.length);

    if (!raw) {
      console.log("🔎 OpenAI output summary (clear):", JSON.stringify(ai?.output ?? null).slice(0, 2000));
    }

    const parsed = parseModelJSON(raw);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (clear) => fallback", err?.code ?? err, err?.preview ? `preview=${err.preview}` : "");
    return res.json(fallbackClearResponse({ question, context, mainCards, branchCards }));
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
