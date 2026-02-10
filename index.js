import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

/* ---------- OpenAI ---------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "innerself-ai", time: new Date().toISOString() });
});

/* ---------- Helpers ---------- */
function normalizeContext(context) {
  const c = (context ?? "").trim();
  return c.length ? c : null;
}

function safeJSONString(obj) {
  return JSON.stringify(obj, null, 0);
}

function parseModelJSON(text) {
  // 有時模型會前後多塞空白或換行
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new Error("EMPTY_MODEL_OUTPUT");
  return JSON.parse(trimmed);
}

/* ---------- JSON Schemas (Structured Outputs) ---------- */
/**
 * NOTE:
 * - strict:true 會要求模型輸出必須符合 schema
 * - additionalProperties:false 會禁止多餘欄位
 */
const ClearV2Schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "language", "question", "context", "directions"],
  properties: {
    version: { type: "string", enum: ["clear_v1_json"] },
    language: { type: "string", enum: ["zh-Hant"] },
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
          actionDirection: { type: "string" },     // 15–30 全形字：由 prompt 規則約束
          possibleOutcome: { type: "string" },     // ≤50 全形字：由 prompt 規則約束
          branches: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "cardText", "possibleOutcome"],
              properties: {
                id: { type: "string" },            // A-1..C-3：由 prompt 內容約束
                cardText: { type: "string" },
                possibleOutcome: { type: "string" } // ≤50 全形字：由 prompt 規則約束
              }
            }
          }
        }
      }
    }
  }
};

const BasicV2Schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "language", "question", "context", "directions"],
  properties: {
    version: { type: "string", enum: ["basic_v1_json"] },
    language: { type: "string", enum: ["zh-Hant"] },
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
          actionDirection: { type: "string" },     // 15–30 全形字：由 prompt 規則約束
          possibleOutcome: { type: "string" }      // ≤50 全形字：由 prompt 規則約束
        }
      }
    }
  }
};

/* ---------- Prompt builders (新版規則：定錨 + 字數) ---------- */
function buildClearPromptV2({ question, context, mainCards, branchCards }) {
  const ctx = normalizeContext(context);

  return `
你是 innerSelf App 的「明晰版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

【輸入】
- 使用者問題：${question}
-（可選）既有前提／已選擇的路徑：${ctx ?? "null"}

主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

子牌：
A-1) ${branchCards[0]}  A-2) ${branchCards[1]}  A-3) ${branchCards[2]}
B-1) ${branchCards[3]}  B-2) ${branchCards[4]}  B-3) ${branchCards[5]}
C-1) ${branchCards[6]}  C-2) ${branchCards[7]}  C-3) ${branchCards[8]}

【嚴格規則】
1) 不改寫任何牌文（cardText 必須逐字等於輸入）。
2) 主牌 A/B/C：每個都要產出
   - actionDirection：一句（15～30 個全形中文字）
   - possibleOutcome：一句（50 個全形中文字以內，含標點）
3) 子牌（A-1~C-3）：只產出
   - possibleOutcome：一句（50 個全形中文字以內，含標點）
4) 【定錨規則】主牌的 actionDirection 與 possibleOutcome 必須同時對應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   actionDirection 必須明確回應問題與前提，描述「行動如何展開」，不得只描述抽象態度或通用建議。
   possibleOutcome 必須回扣問題與前提，描述「可能出現的狀態變化或體驗」，不得保證或下結論。
5) 12 句 possibleOutcome 的句型與語氣盡量避免重複，減少模板感。
6) 不占卜、不預言、不保證、不下成功或失敗的結論。
7) 不得引入使用者未明確提供的具體情境假設（工時/收入/職稱/合約等）。
8) 只能輸出 JSON（不得有任何額外文字）。

【開始】
請直接輸出 JSON。
`.trim();
}

function buildBasicPromptV2({ question, context, mainCards }) {
  const ctx = normalizeContext(context);

  return `
你是 innerSelf App 的「基礎版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

【輸入】
- 使用者問題：${question}
-（可選）既有前提／已選擇的路徑：${ctx ?? "null"}

主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

【嚴格規則】
1) 不改寫任何牌文（cardText 必須逐字等於輸入）。
2) 每張牌都要產出：
   - actionDirection：一句（15～30 個全形中文字）
   - possibleOutcome：一句（50 個全形中文字以內，含標點）
3) 【定錨規則】actionDirection 與 possibleOutcome 必須同時對應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   actionDirection 必須明確回應問題與前提，描述「行動如何展開」，不得只描述抽象態度或通用建議。
   possibleOutcome 必須回扣問題與前提，描述「可能出現的狀態變化或體驗」，不得保證或下結論。
4) 不占卜、不預言、不保證、不下成功或失敗的結論。
5) 不得引入使用者未明確提供的具體情境假設（工時/收入/職稱/合約等）。
6) 只能輸出 JSON（不得有任何額外文字）。

【開始】
請直接輸出 JSON。
`.trim();
}

/* ---------- Fallbacks ---------- */
function fallbackClearResponse({ question, context, mainCards, branchCards }) {
  return {
    version: "clear_v1_json",
    language: "zh-Hant",
    question,
    context: normalizeContext(context),
    directions: [
      {
        id: "A",
        cardText: mainCards[0],
        actionDirection: "先把問題拆小並保留可調整空間",
        possibleOutcome: "焦慮下降些，方向感慢慢浮現。",
        branches: [
          { id: "A-1", cardText: branchCards[0], possibleOutcome: "你會更快看見阻力在哪裡。" },
          { id: "A-2", cardText: branchCards[1], possibleOutcome: "節奏變穩，拉扯感減少。" },
          { id: "A-3", cardText: branchCards[2], possibleOutcome: "你會更敢做出小嘗試。" }
        ]
      },
      {
        id: "B",
        cardText: mainCards[1],
        actionDirection: "先釐清界線與資源再做下一步選擇",
        possibleOutcome: "選擇更一致，代價也更可控。",
        branches: [
          { id: "B-1", cardText: branchCards[3], possibleOutcome: "你會減少不必要的消耗。" },
          { id: "B-2", cardText: branchCards[4], possibleOutcome: "會出現可依靠的支援。" },
          { id: "B-3", cardText: branchCards[5], possibleOutcome: "你會更清楚自己在乎什麼。" }
        ]
      },
      {
        id: "C",
        cardText: mainCards[2],
        actionDirection: "先做最小行動並用回饋校準方向",
        possibleOutcome: "進展出現，但也會暴露新問題。",
        branches: [
          { id: "C-1", cardText: branchCards[6], possibleOutcome: "你會更快拿到實際回饋。" },
          { id: "C-2", cardText: branchCards[7], possibleOutcome: "某個假設會被重新檢視。" },
          { id: "C-3", cardText: branchCards[8], possibleOutcome: "你會找到下一步著力點。" }
        ]
      }
    ]
  };
}

function fallbackBasicResponse({ question, context, mainCards }) {
  return {
    version: "basic_v1_json",
    language: "zh-Hant",
    question,
    context: normalizeContext(context),
    directions: [
      { id: "A", cardText: mainCards[0], actionDirection: "把焦點拉回真正想解決的核心點", possibleOutcome: "雜訊變少，下一步更容易浮現。" },
      { id: "B", cardText: mainCards[1], actionDirection: "做一個低風險的小試探來換取回饋", possibleOutcome: "你會得到可用線索，心更安定。" },
      { id: "C", cardText: mainCards[2], actionDirection: "調整節奏並維持可持續的推進方式", possibleOutcome: "壓力下降，行動更容易延續。" }
    ]
  };
}

/* ---------- API: Clear ---------- */
app.post("/ai/three-card/clear", async (req, res) => {
  const { question, context, mainCards, branchCards } = req.body || {};

  if (
    !question ||
    !Array.isArray(mainCards) ||
    !Array.isArray(branchCards) ||
    mainCards.length !== 3 ||
    branchCards.length !== 9
  ) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  try {
    console.log("➡️ calling OpenAI (clear)");

    const prompt = buildClearPromptV2({ question, context, mainCards, branchCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: [
        { role: "system", content: "You output only JSON. No extra text." },
        { role: "user", content: prompt }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "innerself_three_card_clear",
          strict: true,
          schema: ClearV2Schema
        }
      },
      max_output_tokens: 1100
    });

    const text = (ai.output_text ?? "").trim();
    console.log("✅ OpenAI responded (clear), chars:", text.length);

    const parsed = parseModelJSON(text);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (clear), fallback used:", err);
    return res.json(fallbackClearResponse({ question, context, mainCards, branchCards }));
  }
});

/* ---------- API: Basic ---------- */
app.post("/ai/three-card/basic", async (req, res) => {
  const { question, context, mainCards } = req.body || {};

  if (!question || !Array.isArray(mainCards) || mainCards.length !== 3) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  try {
    console.log("➡️ calling OpenAI (basic)");

    const prompt = buildBasicPromptV2({ question, context, mainCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: [
        { role: "system", content: "You output only JSON. No extra text." },
        { role: "user", content: prompt }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "innerself_three_card_basic",
          strict: true,
          schema: BasicV2Schema
        }
      },
      max_output_tokens: 600
    });

    const text = (ai.output_text ?? "").trim();
    console.log("✅ OpenAI responded (basic), chars:", text.length);

    const parsed = parseModelJSON(text);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (basic), fallback used:", err);
    return res.json(fallbackBasicResponse({ question, context, mainCards }));
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
