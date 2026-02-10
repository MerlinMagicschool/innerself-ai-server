import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

/* ---------- OpenAI ---------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 如果你想要「出錯就 fallback」（不建議在除錯期），把 Cloud Run env 設：
 *   USE_FALLBACK=true
 */
const USE_FALLBACK = String(process.env.USE_FALLBACK || "").toLowerCase() === "true";

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "innerself-ai",
    time: new Date().toISOString(),
    useFallback: USE_FALLBACK
  });
});

/* ---------- Prompt builders (新版：更不模板、且定錨到 question+context+card) ---------- */

function buildClearPrompt({ question, context, mainCards, branchCards }) {
  const q = (question || "").trim();
  const ctx = (context || "").trim();
  const ctxText = ctx ? ctx : "null";

  return `
你是 innerSelf App 的「明晰版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

你的任務：
- 3 張主牌代表三個行動方向（A/B/C）
- 每個方向各有 3 張子牌（A-1..C-3）代表該方向下的三種可能狀態
- 你必須輸出「嚴格 JSON」（實際 JSON 由系統 schema 強制，你只需專心填值）

【輸入】
- 使用者問題：${q}
-（可選）既有前提／已選擇的路徑：${ctxText}

主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

子牌：
A-1) ${branchCards[0]}  A-2) ${branchCards[1]}  A-3) ${branchCards[2]}
B-1) ${branchCards[3]}  B-2) ${branchCards[4]}  B-3) ${branchCards[5]}
C-1) ${branchCards[6]}  C-2) ${branchCards[7]}  C-3) ${branchCards[8]}

【嚴格規則】
1) 不改寫牌文。cardText 必須逐字等於輸入。
2) 主牌 actionDirection：15–30 全形字；possibleOutcome：≤50 全形字（含標點）。
3) 子牌 possibleOutcome：≤50 全形字（含標點）。
4) 【定錨規則】主牌 actionDirection 與 possibleOutcome 必須同時對應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   actionDirection 需描述「在此問題與前提下，採取此牌卡視角，行動如何展開」，不得只寫抽象態度或空泛鼓勵。
   possibleOutcome 需描述「在此問題與前提下，走此方向後可能出現的狀態變化或體驗」，不得保證或下結論。
5) 12 句 possibleOutcome 盡量避免句型重複，降低模板感。
6) 不引入使用者未提供的具體假設（工時/收入/職稱/合約等）。
7) 若資訊不足，改用狀態／感受／節奏描述，不要補設定。

請依以上規則完成內容。
`;
}

function buildBasicPrompt({ question, context, mainCards }) {
  const q = (question || "").trim();
  const ctx = (context || "").trim();
  const ctxText = ctx ? ctx : "null";

  return `
你是 innerSelf App 的「基礎版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

你的任務：
- 3 張主牌代表三個行動方向（A/B/C）
- 每張都要產出 actionDirection 與 possibleOutcome
- 你必須輸出「嚴格 JSON」（實際 JSON 由系統 schema 強制，你只需專心填值）

【輸入】
- 使用者問題：${q}
-（可選）既有前提／已選擇的路徑：${ctxText}

主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

【嚴格規則】
1) 不改寫牌文。cardText 必須逐字等於輸入。
2) actionDirection：15–30 全形字；possibleOutcome：≤50 全形字（含標點）。
3) 【定錨規則】actionDirection 與 possibleOutcome 必須同時對應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   actionDirection 不得只寫抽象態度或空泛鼓勵。
   possibleOutcome 不得保證或下結論。
4) 不引入使用者未提供的具體假設（工時/收入/職稱/合約等）。
5) 若資訊不足，改用狀態／感受／節奏描述，不要補設定。

請依以上規則完成內容。
`;
}

/* ---------- JSON Schemas (強制模型輸出合法 JSON) ---------- */

const CLEAR_SCHEMA = {
  name: "three_card_clear_v1_json",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "language", "question", "context", "directions"],
    properties: {
      version: { const: "clear_v1_json" },
      language: { const: "zh-Hant" },
      question: { type: "string", minLength: 1 },
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
            id: { enum: ["A", "B", "C"] },
            cardText: { type: "string", minLength: 1 },
            actionDirection: { type: "string", minLength: 1 },
            possibleOutcome: { type: "string", minLength: 1 },
            branches: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "cardText", "possibleOutcome"],
                properties: {
                  id: { type: "string", minLength: 1 },
                  cardText: { type: "string", minLength: 1 },
                  possibleOutcome: { type: "string", minLength: 1 }
                }
              }
            }
          }
        }
      }
    }
  }
};

const BASIC_SCHEMA = {
  name: "three_card_basic_v1_json",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "language", "question", "context", "directions"],
    properties: {
      version: { const: "basic_v1_json" },
      language: { const: "zh-Hant" },
      question: { type: "string", minLength: 1 },
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
            id: { enum: ["A", "B", "C"] },
            cardText: { type: "string", minLength: 1 },
            actionDirection: { type: "string", minLength: 1 },
            possibleOutcome: { type: "string", minLength: 1 }
          }
        }
      }
    }
  }
};

/* ---------- Fallbacks (除錯期建議先不要用) ---------- */

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
        actionDirection: "先把焦點拉回此刻可控的一步",
        possibleOutcome: "你會先安定節奏，再看清卡住點。",
        branches: [
          { id: "A-1", cardText: branchCards[0], possibleOutcome: "你會察覺目前的限制。" },
          { id: "A-2", cardText: branchCards[1], possibleOutcome: "你會找回可持續的節奏。" },
          { id: "A-3", cardText: branchCards[2], possibleOutcome: "你會更敢做小幅嘗試。" }
        ]
      },
      {
        id: "B",
        cardText: mainCards[1],
        actionDirection: "先釐清界線與資源，再做選擇",
        possibleOutcome: "壓力下降，決策更貼近你要的生活。",
        branches: [
          { id: "B-1", cardText: branchCards[3], possibleOutcome: "你會釐清真正的重點。" },
          { id: "B-2", cardText: branchCards[4], possibleOutcome: "你會看到可用的支援。" },
          { id: "B-3", cardText: branchCards[5], possibleOutcome: "你會更安心往前走。" }
        ]
      },
      {
        id: "C",
        cardText: mainCards[2],
        actionDirection: "先行動拿回饋，再依結果校準",
        possibleOutcome: "進展會出現，但也會暴露需修正處。",
        branches: [
          { id: "C-1", cardText: branchCards[6], possibleOutcome: "你會獲得實際回饋。" },
          { id: "C-2", cardText: branchCards[7], possibleOutcome: "你會修正一個關鍵假設。" },
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
    context: context ?? null,
    directions: [
      {
        id: "A",
        cardText: mainCards[0],
        actionDirection: "先回到你真正想解決的核心",
        possibleOutcome: "你會把力氣用在更有效的地方。"
      },
      {
        id: "B",
        cardText: mainCards[1],
        actionDirection: "先做一個小試探再看反應",
        possibleOutcome: "你會得到足以調整方向的線索。"
      },
      {
        id: "C",
        cardText: mainCards[2],
        actionDirection: "先調整節奏，讓行動能持續",
        possibleOutcome: "你會減少內耗，穩定把事推進。"
      }
    ]
  };
}

/* ---------- Helpers ---------- */

// 從 Responses API 取出「已經是 JSON 物件」的結果（避免自己 parse 字串）
function extractJsonObject(ai) {
  // 這段寫得保守：不同 SDK 版本欄位可能不完全一致
  // 目標：找到 response_format/json_schema 生成的 object
  const out = ai?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        // 常見：{ type: "output_json", json: {...} } 或 { type:"output_text", text:"..." }
        if (c?.type === "output_json" && c?.json && typeof c.json === "object") return c.json;
        if (c?.type === "json" && c?.json && typeof c.json === "object") return c.json;
        if (c?.type === "output_text" && typeof c.text === "string") {
          // 萬一 schema 沒生效，退回文字 parse（但會加 debug）
          const t = c.text.trim();
          if (t.startsWith("{") && t.endsWith("}")) return JSON.parse(t);
        }
      }
    }
  }

  // 有些 SDK 直接提供 output_text；最後手段才用
  const text = (ai?.output_text || "").trim();
  if (text) return JSON.parse(text);

  throw new Error("NO_JSON_OUTPUT");
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

    const prompt = buildClearPrompt({ question, context, mainCards, branchCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      max_output_tokens: 1200,
      temperature: 0.4,
      response_format: { type: "json_schema", json_schema: CLEAR_SCHEMA }
    });

    console.log("✅ OpenAI responded (clear)");

    const obj = extractJsonObject(ai);

    console.log("✅ JSON extracted, returning to client (clear)");
    return res.json(obj);
  } catch (err) {
    console.error("⚠️ OpenAI failed (clear):", err);

    if (USE_FALLBACK) {
      console.warn("↩️ returning fallback (clear)");
      return res.json(fallbackClearResponse({ question, context, mainCards, branchCards }));
    }

    return res.status(502).json({
      error: "OPENAI_CLEAR_FAILED",
      message: String(err?.message || err),
      hint: "Check OpenAI billing/quota, or schema/output parsing."
    });
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

    const prompt = buildBasicPrompt({ question, context, mainCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      max_output_tokens: 700,
      temperature: 0.4,
      response_format: { type: "json_schema", json_schema: BASIC_SCHEMA }
    });

    console.log("✅ OpenAI responded (basic)");

    const obj = extractJsonObject(ai);

    console.log("✅ JSON extracted, returning to client (basic)");
    return res.json(obj);
  } catch (err) {
    console.error("⚠️ OpenAI failed (basic):", err);

    if (USE_FALLBACK) {
      console.warn("↩️ returning fallback (basic)");
      return res.json(fallbackBasicResponse({ question, context, mainCards }));
    }

    return res.status(502).json({
      error: "OPENAI_BASIC_FAILED",
      message: String(err?.message || err),
      hint: "Check OpenAI billing/quota, or schema/output parsing."
    });
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
