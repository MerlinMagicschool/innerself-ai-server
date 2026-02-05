import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

/* ---------- OpenAI ---------- */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "innerself-ai",
    time: new Date().toISOString()
  });
});

/* ---------- Prompt builder ---------- */
/**
 * Build clear JSON prompt (must match PromptCatalog.clearV1JSON)
 */
function buildClearPrompt({ question, context, mainCards, branchCards }) {
  const ctx = context && context.trim() ? context.trim() : "null";

  return `
你是 innerSelf App 的「明晰版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

你的任務：
- 3 張主牌代表三個行動方向（A/B/C）
- 每個方向有 3 張子牌
- 請輸出「嚴格 JSON」

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
1) 不改寫牌文。
2) 主牌要有 actionDirection（10–18 字）與 possibleOutcome（≤30 字）。
3) 子牌只要 possibleOutcome（≤30 字）。
4) 不占卜、不保證、不下結論。
5) 嚴格輸出 JSON，不得有多餘文字。

【輸出 JSON Schema】
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
請直接輸出 JSON。
`;
}

/* ---------- Fallback ---------- */
function fallbackResponse({ question, context, mainCards, branchCards }) {
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

/* ---------- API ---------- */
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
    console.log("➡️ calling OpenAI");

    const prompt = buildClearPrompt({
      question,
      context,
      mainCards,
      branchCards
    });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      max_output_tokens: 500
    });

    console.log("✅ OpenAI responded");

    const text = ai.output_text;
    const parsed = JSON.parse(text);

    console.log("✅ JSON parsed, returning to client");

    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed, fallback used:", err);
    return res.json(
      fallbackResponse({ question, context, mainCards, branchCards })
    );
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
