import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "innerself-ai",
    time: new Date().toISOString(),
  });
});

/* ---------- Utils ---------- */
function badRequest(res, message) {
  return res.status(400).json({ error: "Invalid request body", message });
}

function extractText(resp) {
  // 1) SDK convenience
  if (typeof resp?.output_text === "string" && resp.output_text.trim().length > 0) {
    return resp.output_text.trim();
  }

  // 2) Walk through output -> content
  const chunks = [];
  const out = resp?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (typeof c?.text === "string" && c.text.trim().length > 0) {
          chunks.push(c.text.trim());
        }
      }
    }
  }
  return chunks.length ? chunks.join("") : "";
}

function parseModelJSON(raw) {
  const s = (raw ?? "").trim();
  if (!s) {
    const err = new Error("EMPTY_MODEL_OUTPUT");
    err.code = "EMPTY_MODEL_OUTPUT";
    throw err;
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    const err = new Error("JSON_PARSE_FAILED");
    err.code = "JSON_PARSE_FAILED";
    err.details = e?.message ?? String(e);
    err.preview = s.slice(0, 600);
    throw err;
  }
}

/* ---------- Prompt builders (只允許 JSON) ---------- */
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

【嚴格規則】
1) 不改寫牌文（cardText 必須逐字等於輸入）。
2) 每張牌都要有：
   - actionDirection：一句（15～30 個全形中文字）
   - possibleOutcome：一句（≤50 個全形中文字，含標點）
3) 【定錨規則】actionDirection 與 possibleOutcome 必須同時回應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   不得只描述抽象態度或通用建議。
4) 不占卜、不保證、不下結論。
5) 只能輸出「單一 JSON 物件」，不得包含任何額外文字，不得使用 Markdown。

【輸出 JSON Schema（必須完全符合）】
{
  "version": "basic_v1_json",
  "language": "zh-Hant",
  "question": string,
  "context": string | null,
  "directions": [
    { "id": "A", "cardText": string, "actionDirection": string, "possibleOutcome": string },
    { "id": "B", "cardText": string, "actionDirection": string, "possibleOutcome": string },
    { "id": "C", "cardText": string, "actionDirection": string, "possibleOutcome": string }
  ]
}

【開始】
請直接輸出符合 Schema 的 JSON。
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

【嚴格規則】
1) 不改寫牌文（cardText 必須逐字等於輸入）。
2) 主牌 A/B/C：每個都要有
   - actionDirection：一句（15～30 個全形中文字）
   - possibleOutcome：一句（≤50 個全形中文字，含標點）
3) 子牌（A-1~C-3）：只輸出
   - possibleOutcome：一句（≤50 個全形中文字，含標點）
4) 【定錨規則】主牌 actionDirection 與 possibleOutcome 必須同時回應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   不得只描述抽象態度或通用建議。
5) 只能輸出「單一 JSON 物件」，不得包含任何額外文字，不得使用 Markdown。

【輸出 JSON Schema（必須完全符合）】
{
  "version": "clear_v1_json",
  "language": "zh-Hant",
  "question": string,
  "context": string | null,
  "directions": [
    {
      "id": "A",
      "cardText": string,
      "actionDirection": string,
      "possibleOutcome": string,
      "branches": [
        { "id": "A-1", "cardText": string, "possibleOutcome": string },
        { "id": "A-2", "cardText": string, "possibleOutcome": string },
        { "id": "A-3", "cardText": string, "possibleOutcome": string }
      ]
    },
    {
      "id": "B",
      "cardText": string,
      "actionDirection": string,
      "possibleOutcome": string,
      "branches": [
        { "id": "B-1", "cardText": string, "possibleOutcome": string },
        { "id": "B-2", "cardText": string, "possibleOutcome": string },
        { "id": "B-3", "cardText": string, "possibleOutcome": string }
      ]
    },
    {
      "id": "C",
      "cardText": string,
      "actionDirection": string,
      "possibleOutcome": string,
      "branches": [
        { "id": "C-1", "cardText": string, "possibleOutcome": string },
        { "id": "C-2", "cardText": string, "possibleOutcome": string },
        { "id": "C-3", "cardText": string, "possibleOutcome": string }
      ]
    }
  ]
}

【開始】
請直接輸出符合 Schema 的 JSON。
`.trim();
}

/* ---------- API: Basic (JSON) ---------- */
app.post("/ai/three-card/basic", async (req, res) => {
  const { question, context, mainCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) {
    return badRequest(res, "mainCards must be length 3");
  }

  try {
    console.log("➡️ calling OpenAI (basic)");

    const prompt = buildBasicPrompt({ question, context, mainCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      // ✅ Responses API 正確的 JSON mode 參數
      text: { format: { type: "json_object" } },
      // 暫時不設 max_output_tokens（你要先回到原始行為排查）
    });

    console.log("🔎 output_text len:", (ai.output_text || "").length);
    console.log(
      "🔎 raw OpenAI response (truncated):",
      JSON.stringify(ai, null, 2).slice(0, 4000)
    );

    const raw = extractText(ai);
    console.log("🔎 extracted len:", raw.length);
    console.log("🔎 extracted preview:", raw.slice(0, 400));

    const parsed = parseModelJSON(raw);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (basic):", err?.code ?? err, err?.preview ? `preview=${err.preview}` : "");
    return res.status(502).json({
      error: "OPENAI_BASIC_FAILED",
      message: err?.message ?? String(err),
      code: err?.code ?? null,
      preview: err?.preview ?? null,
      details: err?.details ?? null,
    });
  }
});

/* ---------- API: Clear (JSON) ---------- */
app.post("/ai/three-card/clear", async (req, res) => {
  const { question, context, mainCards, branchCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) {
    return badRequest(res, "mainCards must be length 3");
  }
  if (!Array.isArray(branchCards) || branchCards.length !== 9) {
    return badRequest(res, "branchCards must be length 9");
  }

  try {
    console.log("➡️ calling OpenAI (clear)");

    const prompt = buildClearPrompt({ question, context, mainCards, branchCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      text: { format: { type: "json_object" } },
    });

    console.log("🔎 output_text len:", (ai.output_text || "").length);
    console.log(
      "🔎 raw OpenAI response (truncated):",
      JSON.stringify(ai, null, 2).slice(0, 4000)
    );

    const raw = extractText(ai);
    console.log("🔎 extracted len:", raw.length);
    console.log("🔎 extracted preview:", raw.slice(0, 400));

    const parsed = parseModelJSON(raw);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (clear):", err?.code ?? err, err?.preview ? `preview=${err.preview}` : "");
    return res.status(502).json({
      error: "OPENAI_CLEAR_FAILED",
      message: err?.message ?? String(err),
      code: err?.code ?? null,
      preview: err?.preview ?? null,
      details: err?.details ?? null,
    });
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
