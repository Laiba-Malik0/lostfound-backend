
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mongoose = require("mongoose");
const Item = require("../models/Item");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const MODEL_NAME = "gemini-3.8-flash";
const AI_TIMEOUT = 8000;

// Prevent slow AI requests from blocking the API response.
const withTimeout = (promise, ms = AI_TIMEOUT) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("AI request timeout")), ms);
    }),
  ]);
};

// Local matching fallback
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

// Safe JSON parser
const parseAIJSON = (text) => {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(cleaned);
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

    // Local matching runs immediately.
    let scoredMatches = getKeywordMatches(
      currentItem,
      candidateItems
    );

    // AI gets ONE attempt. Local results remain available
    // if Google AI is slow or unavailable.
    if (process.env.GEMINI_API_KEY) {
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

        const model = genAI.getGenerativeModel({
          model: MODEL_NAME,
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: "application/json",
          },
        });

        const result = await withTimeout(
          model.generateContent(prompt),
          6000
        );

        const parsed = parseAIJSON(
          result.response.text()
        );

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
              reason: String(
                item.reason || "Potential item match."
              ),
            }))
            .filter((item) => item.matchScore >= 50);

          // Use AI results when valid.
          if (aiMatches.length) {
            scoredMatches = aiMatches;
          }
        }
      } catch (error) {
        console.warn(
          "AI matching fallback:",
          error.message
        );
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
        const candidate = candidateById.get(
          match.candidateId
        );

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
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        message: "Image is required.",
      });
    }

    const cleanBase64 = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    // Prevent oversized requests.
    if (cleanBase64.length > 8 * 1024 * 1024) {
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

    if (!process.env.GEMINI_API_KEY) {
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

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    });

    const result = await withTimeout(
      model.generateContent([
        prompt,
        {
          inlineData: {
            data: cleanBase64,
            mimeType: safeMimeType,
          },
        },
      ]),
      8000
    );

    const analysis = parseAIJSON(
      result.response.text()
    );

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
        description: String(
          analysis.description || ""
        ).slice(0, 300),
      },
    });
  } catch (error) {
    console.error(
      "IMAGE SCAN ERROR:",
      error.message
    );

    // Fast fallback instead of waiting for another model.
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
