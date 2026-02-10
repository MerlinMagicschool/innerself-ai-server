import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "innerself-ai", time: new Date().toISOString() });
});

/* ---------- Helpers ---------- */
function extractOutputText(resp) {
  // Responses API 可能把文字放在 resp.output[].content[] 裡
  const parts = [];
  for (const item of resp.output ?? []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        // 常見是 output_text
        if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
        // 有些情況會是 text
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join("").trim();
}

function parseModelJSON(text) {
  if (!text || !text.trim()) {
    throw new Error("EMPTY_MODEL_OUTPUT");
  }
  return JSON.parse(text);
}

/* ---------- JSON Schemas (Structured Outputs) ---------- */
const basicSchema = {
  name: "innerself_basic_v1",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "language", "question", "context", "directions"],
    properties: {
      version: { type: "string", const: "basic_v1_json" },
      language: { type: "string", const: "zh-Hant" },
      question: { type: "string" },
      context: { anyOf: [{ type: "string" }, { type: "null" }] },
      directions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "cardText", "actionDirection", "possibleOutcome"],
          properties: {
            id: { type: "string", enum: ["A", "B", "C"] },
            cardText: { type: "string" },
            actionDirection: { type: "string" },
            possibleOutcome: { type: "string" }
          }
        }
      }
    }
  },
  strict: true
};

const clearSchema = {
  name: "innerself_clear_v1",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "language", "question", "context", "directions"],
    properties: {
      version: { type: "string", const: "clear_v1_json" },
      language: { type: "string", const: "zh-Hant" },
      question: { type: "string" },
      context: { anyOf: [{ type: "string" }, { type: "null" }] },
      directions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "cardText", "actionDirection", "possibleOutcome", "branches"],
          properties: {
            id: { type: "string", enum: ["A", "B", "C"] },
            cardText: { type: "string" },
            actionDirection: { type: "string" },
            possibleOutcome: { type: "string" },
            branches: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "cardText", "possibleOutcome"],
                properties: {
                  id: { type: "string" },
                  cardText: { type: "string" },
                  possibleOutcome: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  strict: true
};

/* ---------- Prompt builders (文字規則仍保留，格式由 json_schema 強制) ---------- */
function buildBasicPrompt({ question, context, mainCards }) {
  const ctx = context && context.trim() ? context.trim() : "null";
  return `
你是 innerSelf App 的「基礎版三張回應卡」引導者。抽牌已在 App 端完成，你不需要也不可以再抽牌。

【輸入】
- 使用者問題：${question}
-（可選）既有前提／已選擇的路徑：${ctx}
主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

【規則】
1) 不改寫牌文（cardText 必須逐字等於輸入）。
2) 每張牌要輸出 actionDirection（15–30字）與 possibleOutcome（≤50字）。
3) 【定錨】actionDirection/possibleOutcome 必須同時回應：問題＋（若有）前提＋此牌在此情境的行動視角；不得只講抽象態度。
4) 不占卜、不保證、不下結論。
只輸出 JSON。
`.trim();
}

function buildClearPrompt({ question, context, mainCards, branchCards }) {
  const ctx = context && context.trim() ? context.trim() : "null";
  return `
你是 innerSelf App 的「明晰版三張回應卡」引導者。抽牌已在 App 端完成，你不需要也不可以再抽牌。

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
1) 不改寫牌文（cardText 必須逐字等於輸入）。
2) 主牌：actionDirection（15–30字），possibleOutcome（≤50字）。
3) 子牌：possibleOutcome（≤50字）。
4) 【定錨】主牌 actionDirection/possibleOutcome 必須同時回應：問題＋（若有）前提＋此牌在此情境的行動視角；不得只講抽象態度。
5) 12句 possibleOutcome 盡量避免模板句型重複。
6) 不占卜、不保證、不下結論。
只輸出 JSON。
`.trim();
}

/* ---------- Fallbacks ---------- */
function fallbackBasicResponse({ question, context, mainCards }) {
  return {
    version: "basic_v1_json",
    language: "zh-Hant",
    question,
    context: context ?? null,
    directions: [
      { id: "A", cardText: mainCards[0], actionDirection: "先把注意力拉回可控的一步", possibleOutcome: "焦慮下降，下一步更容易啟動。" },
      { id: "B", cardText: mainCards[1], actionDirection: "用小試探換取更真實的回饋", possibleOutcome: "資訊變多，判斷會更貼近現況。" },
      { id: "C", cardText: mainCards[2], actionDirection: "調整節奏與界線後再往前推", possibleOutcome: "消耗變少，行動更能持續。" }
    ]
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
          { id: "A-3", cardText: branchCards[2], possibleOutcome: "你會減少內在拉扯。" }
        ]
      },
      {
        id: "B",
        cardText: mainCards[1],
        actionDirection: "調整資源配置與界線",
        possibleOutcome: "壓力降低，選擇更一致。",
        branches: [
          { id: "B-1", cardText: branchCards[3], possibleOutcome: "你會釐清真正的重點。" },
          { id: "B-2", cardText: branchCards[4], possibleOutcome: "會出現支援的可能。" },
          { id: "B-3", cardText: branchCards[5], possibleOutcome: "你會更安心行動。" }
        ]
      },
      {
        id: "C",
        cardText: mainCards[2],
        actionDirection: "先行動再修正方向",
        possibleOutcome: "進展出現，但需反覆調整。",
        branches: [
          { id: "C-1", cardText: branchCards[6], possibleOutcome: "你會獲得實際回饋。" },
          { id: "C-2", cardText: branchCards[7], possibleOutcome: "假設會被重新檢視。" },
          { id: "C-3", cardText: branchCards[8], possibleOutcome: "下一步逐漸成形。" }
        ]
      }
    ]
  };
}

/* ---------- API: Basic ---------- */
app.post("/ai/three-card/basic", async (req, res) => {
  const { question, context, mainCards } = req.body || {};
  if (!question || !Array.isArray(mainCards) || mainCards.length !== 3) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  try {
    console.log("➡️ calling OpenAI (basic)");

    const prompt = buildBasicPrompt({ question, context, mainCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      max_output_tokens: 1200, // 500 很容易截斷 JSON；先用 1200 把「穩」做出來
      text: {
        format: {
          type: "json_schema",
          name: basicSchema.name,
          schema: basicSchema.schema,
          strict: true
        }
      }
    });

    const text = extractOutputText(ai);
    console.log("✅ OpenAI responded (basic), chars:", text.length);

    const parsed = parseModelJSON(text);
    return res.json(parsed);
  } catch (err) {
    console.error("⚠️ OpenAI failed (basic), fallback used:", err);
    return res.json(fallbackBasicResponse({ question, context, mainCards }));
  }
});

/* ---------- API: Clear ---------- */
app.post("/ai/three-card/clear", async (req, res) => {
  const { question, context, mainCards, branchCards } = req.body || {};
  if (
    !question ||
    !Array.isArray(mainCards) || mainCards.length !== 3 ||
    !Array.isArray(branchCards) || branchCards.length !== 9
  ) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  try {
    console.log("➡️ calling OpenAI (clear)");

    const prompt = buildClearPrompt({ question, context, mainCards, branchCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      max_output_tokens: 1600, // clear 會更長，先避免截斷
      text: {
        format: {
          type: "json_schema",
          name: clearSchema.name,
          schema: clearSchema.schema,
          strict: true
        }
      }
    });

    const text = extractOutputText(ai);
    console.log("✅ OpenAI responded (clear), chars:", text.length);

    const parsed = parseModelJSON(text);
    return res.json(parsed);
  } catch (err) {
    console.error("⚠️ OpenAI failed (clear), fallback used:", err);
    return res.json(fallbackClearResponse({ question, context, mainCards, branchCards }));
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
