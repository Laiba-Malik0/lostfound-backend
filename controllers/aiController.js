const { GoogleGenerativeAI } = require("@google/generative-ai");
const mongoose = require("mongoose");
const Item = require("../models/Item");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const AI_TIMEOUT = Number(process.env.AI_TIMEOUT_MS) || 7500;

// Reuse one SDK client per serverless instance.
const genAI = GEMINI_API_KEY
  ? new GoogleGenerativeAI(GEMINI_API_KEY)
  : null;

// A small per-instance queue prevents a burst of requests from sending
// unlimited simultaneous calls to Gemini. Requests outside the queue fall
// back to the existing local matching / empty scanner response.
const MAX_CONCURRENT_AI_REQUESTS = Number(process.env.AI_MAX_CONCURRENCY) || 4;
const MAX_QUEUED_AI_REQUESTS = Number(process.env.AI_MAX_QUEUE) || 16;
const AI_QUEUE_WAIT_MS = Number(process.env.AI_QUEUE_WAIT_MS) || 2000;

let activeAIRequests = 0;
const aiRequestQueue = [];

const runAIRequest = (task) =>
  new Promise((resolve, reject) => {
    const start = () => {
      activeAIRequests += 1;

      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeAIRequests = Math.max(0, activeAIRequests - 1);

          const next = aiRequestQueue.shift();
          if (next) {
            clearTimeout(next.timer);
            next.start();
          }
        });
    };

    if (activeAIRequests < MAX_CONCURRENT_AI_REQUESTS) {
      start();
      return;
    }

    if (aiRequestQueue.length >= MAX_QUEUED_AI_REQUESTS) {
      const error = new Error("AI service is busy. Please try again shortly.");
      error.code = "AI_QUEUE_FULL";
      reject(error);
      return;
    }

    const queuedTask = {
      start,
      timer: null,
    };

    queuedTask.timer = setTimeout(() => {
      const index = aiRequestQueue.indexOf(queuedTask);

      if (index !== -1) {
        aiRequestQueue.splice(index, 1);
        const error = new Error("AI request queue timed out.");
        error.code = "AI_QUEUE_TIMEOUT";
        reject(error);
      }
    }, AI_QUEUE_WAIT_MS);

    aiRequestQueue.push(queuedTask);
  });

// Local matching fallback. Scoring and matching rules are intentionally
// kept the same as the existing implementation.
const getKeywordMatches = (currentItem, candidateItems) => {
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2);

  const targetWords = [
    ...new Set([
      ...normalize(currentItem.title),
      ...normalize(currentItem.description),
      ...normalize(currentItem.location),
    ]),
  ];

  return candidateItems
    .map((candidate) => {
      let score = 0;

      if (
        currentItem.category &&
        candidate.category &&
        currentItem.category.toLowerCase() ===
          candidate.category.toLowerCase()
      ) {
        score += 40;
      }

      const candidateWords = new Set([
        ...normalize(candidate.title),
        ...normalize(candidate.description),
        ...normalize(candidate.location),
      ]);

      const matched = targetWords.filter((word) =>
        candidateWords.has(word)
      ).length;

      if (targetWords.length) {
        score += Math.min(
          60,
          Math.round((matched / targetWords.length) * 60)
        );
      }

      return {
        candidateId: candidate._id.toString(),
        matchScore: Math.min(100, score),
        reason: "Matched using item category, description and location.",
      };
    })
    .filter((item) => item.matchScore >= 40)
    .sort((a, b) => b.matchScore - a.matchScore);
};

const parseAIJSON = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("AI returned an empty response.");
  }

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(cleaned);
};

const createGeminiModel = (maxOutputTokens) => {
  return genAI.getGenerativeModel(
    {
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens,
        responseMimeType: "application/json",
      },
    },
    {
      // The SDK applies this timeout to the HTTP request itself.
      timeout: AI_TIMEOUT,
    }
  );
};

// ========================================
// 1. AI LOST AND FOUND MATCHING
// ========================================

const matchItemWithAI = async (req, res) => {
  try {
    const { itemId } = req.body;

    if (!itemId || !mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({
        success: false,
        message: "Valid item ID is required.",
      });
    }

    const currentItem = await Item.findById(itemId).lean();

    if (!currentItem) {
      return res.status(404).json({
        success: false,
        message: "Item not found.",
      });
    }

    // Existing Lost <-> Found matching rules are unchanged.
    const oppositeType =
      currentItem.type === "lost" ? "found" : "lost";

    const requesterId = req.user?._id;

    const candidateItems = await Item.find({
      type: oppositeType,
      status: "open",
      ...(requesterId
        ? { user: { $ne: requesterId } }
        : {}),
    })
      .select(
        "title category description location type status imageUrl date user createdAt"
      )
      .populate("user", "name email phone")
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    if (!candidateItems.length) {
      return res.status(200).json({
        success: true,
        currentItemId: currentItem._id,
        currentItemType: currentItem.type,
        expectedMatchType: oppositeType,
        matches: [],
        message: `No open ${oppositeType} items found.`,
      });
    }

    // Local matching is always available, even if Gemini is unavailable.
    let scoredMatches = getKeywordMatches(currentItem, candidateItems);

    if (genAI) {
      try {
        const candidatePayload = candidateItems.map((item) => ({
          candidateId: item._id.toString(),
          title: item.title,
          category: item.category,
          location: item.location,
          description: item.description,
        }));

        const prompt = `
You are a Lost and Found matching assistant.

Compare the target item with candidate items.
Only return genuine possible matches.
Use only candidateId values from the provided list.
Return matchScore between 50 and 100.
Return only valid JSON array.

TARGET:
${JSON.stringify({
  title: currentItem.title,
  category: currentItem.category,
  location: currentItem.location,
  description: currentItem.description,
  type: currentItem.type,
})}

CANDIDATES:
${JSON.stringify(candidatePayload)}

FORMAT:
[
  {
    "candidateId": "exact_id",
    "matchScore": 85,
    "reason": "Matching item details"
  }
]
`;

        const model = createGeminiModel(1024);
        const result = await runAIRequest(() =>
          model.generateContent(prompt)
        );

        const parsed = parseAIJSON(result.response.text());

        if (Array.isArray(parsed)) {
          const allowedIds = new Set(
            candidateItems.map((item) => item._id.toString())
          );

          const aiMatches = parsed
            .filter(
              (item) =>
                item &&
                allowedIds.has(String(item.candidateId))
            )
            .map((item) => ({
              candidateId: String(item.candidateId),
              matchScore: Math.max(
                0,
                Math.min(100, Number(item.matchScore) || 0)
              ),
              reason: String(item.reason || "Potential item match."),
            }))
            .filter((item) => item.matchScore >= 50);

          if (aiMatches.length) {
            scoredMatches = aiMatches;
          }
        }
      } catch (error) {
        console.warn("AI matching fallback:", error.message);
      }
    }

    const candidateById = new Map(
      candidateItems.map((item) => [
        item._id.toString(),
        item,
      ])
    );

    const matches = scoredMatches
      .map((match) => {
        const candidate = candidateById.get(match.candidateId);

        if (
          !candidate ||
          candidate.type !== oppositeType ||
          candidate.status !== "open"
        ) {
          return null;
        }

        return {
          candidateId: candidate._id.toString(),
          _id: candidate._id,
          title: candidate.title,
          description: candidate.description,
          category: candidate.category,
          location: candidate.location,
          type: candidate.type,
          imageUrl: candidate.imageUrl,
          image: candidate.imageUrl,
          date: candidate.date,
          status: candidate.status,
          user: candidate.user,
          matchScore: match.matchScore,
          reason: match.reason,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchScore - a.matchScore);

    return res.status(200).json({
      success: true,
      currentItemId: currentItem._id,
      currentItemType: currentItem.type,
      expectedMatchType: oppositeType,
      matches,
    });
  } catch (error) {
    console.error("MATCH CONTROLLER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to process item matching.",
    });
  }
};

// ========================================
// 2. IMAGE SCANNER AND AUTO-FILL
// ========================================

const analyzeImageWithAI = async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body || {};

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({
        success: false,
        message: "Image is required.",
      });
    }

    const cleanBase64 = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    if (!cleanBase64 || cleanBase64.length > 8 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        message: "Image is too large. Please upload a smaller image.",
      });
    }

    const allowedMimeTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
    ];

    const safeMimeType = allowedMimeTypes.includes(mimeType)
      ? mimeType
      : "image/jpeg";

    const fallbackResponse = {
      success: true,
      fallback: true,
      analysis: {
        title: "",
        category: "Others",
        description: "",
      },
    };

    if (!genAI) {
      return res.status(200).json(fallbackResponse);
    }

    const prompt = `
Analyze the uploaded Lost and Found item image.

Return ONLY valid JSON:
{
  "title": "Short 2-3 word object name",
  "category": "Electronics, Documents, Keys, Clothing, Jewelry, or Others",
  "description": "One short sentence describing visible physical details."
}

Rules:
- Identify the main physical object.
- Do not invent brand names or model numbers.
- Category must be exactly one of the allowed values.
- Keep description short.
`;

    const model = createGeminiModel(256);
    const result = await runAIRequest(() =>
      model.generateContent([
        prompt,
        {
          inlineData: {
            data: cleanBase64,
            mimeType: safeMimeType,
          },
        },
      ])
    );

    const analysis = parseAIJSON(result.response.text());

    const allowedCategories = [
      "Electronics",
      "Documents",
      "Keys",
      "Clothing",
      "Jewelry",
      "Others",
    ];

    return res.status(200).json({
      success: true,
      fallback: false,
      analysis: {
        title: String(analysis.title || "").slice(0, 80),
        category: allowedCategories.includes(analysis.category)
          ? analysis.category
          : "Others",
        description: String(analysis.description || "").slice(0, 300),
      },
    });
  } catch (error) {
    console.error("IMAGE SCAN ERROR:", error.message);

    return res.status(200).json({
      success: true,
      fallback: true,
      analysis: {
        title: "",
        category: "Others",
        description: "",
      },
    });
  }
};

module.exports = {
  matchItemWithAI,
  analyzeImageWithAI,
};
