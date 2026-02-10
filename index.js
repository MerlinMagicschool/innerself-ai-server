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

/* ---------- Prompt builders ---------- */
/**
 * Build clear JSON prompt (must match PromptCatalog.clearV1JSON)
 */
 function buildClearPrompt({ question, context, mainCards, branchCards }) {
   const ctx = context && context.trim() ? context.trim() : "null";

   return `
 你是 innerSelf App 的「明晰版三張回應卡」引導者。
 抽牌已在 App 端完成，你不需要、也不可以再抽牌。

 你的角色不是占卜者，而是「協助使用者在既有問題與前提下，看清不同行動視角」的引導者。

 【任務說明】
 - 3 張主牌代表三個「可採取的行動方向」（A / B / C）
 - 每個方向各有 3 張子牌，用來補充細部變化
 - 請依規則輸出「嚴格 JSON」，不得有任何多餘文字

 【輸入資料】
 - 使用者問題：${question}
 - 既有前提／已選擇的路徑（若無則為 null）：${ctx}

 主牌：
 A) ${mainCards[0]}
 B) ${mainCards[1]}
 C) ${mainCards[2]}

 子牌：
 A-1) ${branchCards[0]}  A-2) ${branchCards[1]}  A-3) ${branchCards[2]}
 B-1) ${branchCards[3]}  B-2) ${branchCards[4]}  B-3) ${branchCards[5]}
 C-1) ${branchCards[6]}  C-2) ${branchCards[7]}  C-3) ${branchCards[8]}

 【定錨規則（非常重要）】
 - actionDirection 必須同時回應：
   1) 使用者的「問題」
   2)（若有）既有前提／已選擇的路徑
   3) 該牌卡在此情境下提供的行動視角
 - actionDirection 描述的是：
   「在此問題與前提脈絡下，若採取此牌卡的視角，行動應如何展開」
   不得只描述抽象態度、心境或通用建議。
 - possibleOutcome 描述的是：
   「在此問題與前提脈絡下，若採取該行動方向，可能出現的狀態變化或體驗」
   不得做出保證、預測結果或下結論。

 【字數限制】
 - 主牌 actionDirection：15–30 字
 - 主牌 possibleOutcome：≤50 字
 - 子牌 possibleOutcome：≤50 字

 【其他嚴格規則】
 1) 不得改寫或詮釋牌文文字。
 2) 子牌只輸出 possibleOutcome，不輸出行動指示。
 3) 不占卜、不保證、不下結論、不使用命定語氣。
 4) 嚴格輸出 JSON，禁止任何解說文字。

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

/**
 * Build basic JSON prompt (must match PromptCatalog.basicV1JSON)
 */
 function buildBasicPrompt({ question, context, mainCards }) {
   const ctx = context && context.trim() ? context.trim() : "null";

   return `
 你是 innerSelf App 的「基礎版三張回應卡」引導者。
 抽牌已在 App 端完成，你不需要、也不可以再抽牌。

 你的角色是協助使用者「在既有問題與前提下，看見三種不同的行動切入點」。

 【任務說明】
 - 3 張主牌代表三個行動方向（A / B / C）
 - 每個方向都必須對應使用者的問題與前提
 - 請依規則輸出「嚴格 JSON」

 【輸入資料】
 - 使用者問題：${question}
 - 既有前提／已選擇的路徑（若無則為 null）：${ctx}

 主牌：
 A) ${mainCards[0]}
 B) ${mainCards[1]}
 C) ${mainCards[2]}

 【定錨規則（非常重要）】
 - actionDirection 必須明確回應使用者的問題，
   並在既有前提下，體現該牌卡提供的行動視角。
 - 不得只描述抽象態度或通用建議。
 - possibleOutcome 描述的是：
   在此問題與前提下，採取該行動方向後，可能出現的狀態或體驗變化。

 【字數限制】
 - actionDirection：15–30 字
 - possibleOutcome：≤50 字

 【其他嚴格規則】
 1) 不得改寫或詮釋牌文文字。
 2) 不占卜、不保證、不下結論。
 3) 嚴格輸出 JSON，不得有多餘文字。

 【輸出 JSON Schema】
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
 請直接輸出 JSON。
 `;
 }

/* ---------- Fallback ---------- */
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
        actionDirection: "先把重點拉回自己",
        possibleOutcome: "你會更清楚下一步該怎麼做。"
      },
      {
        id: "B",
        cardText: mainCards[1],
        actionDirection: "先做一個小試探",
        possibleOutcome: "你會得到可用的回饋與線索。"
      },
      {
        id: "C",
        cardText: mainCards[2],
        actionDirection: "調整節奏再前進",
        possibleOutcome: "壓力下降，行動更能持續。"
      }
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

    const prompt = buildClearPrompt({
      question,
      context,
      mainCards,
      branchCards
    });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      max_output_tokens: 1200
    });

    console.log("✅ OpenAI responded (clear)");

    const text = ai.output_text;
    const parsed = JSON.parse(text);

    console.log("✅ JSON parsed, returning to client (clear)");

    return res.json(parsed);
  } catch (err) {
    console.error("⚠️ OpenAI failed (clear), fallback used:", err);
    return res.json(
      fallbackClearResponse({ question, context, mainCards, branchCards })
    );
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

    const prompt = buildBasicPrompt({
      question,
      context,
      mainCards
    });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
      max_output_tokens: 1200
    });

    console.log("✅ OpenAI responded (basic)");

    const text = ai.output_text;
    const parsed = JSON.parse(text);

    console.log("✅ JSON parsed, returning to client (basic)");

    return res.json(parsed);
  } catch (err) {
    console.error("⚠️ OpenAI failed (basic), fallback used:", err);
    return res.json(
      fallbackBasicResponse({ question, context, mainCards })
    );
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
