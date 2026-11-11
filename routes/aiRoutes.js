
const express = require("express");
const router = express.Router();

const {
  matchItemWithAI,
  analyzeImageWithAI,
} = require("../controllers/aiController");

const { protect } = require("../middleware/authMiddleware");

router.post("/match", protect, matchItemWithAI);
router.post("/analyze-image", protect, analyzeImageWithAI);

module.exports = router;
