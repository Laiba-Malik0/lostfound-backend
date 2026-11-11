const jwt = require("jsonwebtoken");
const User = require("../models/User");

const protect = async (req, res, next) => {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "Not authorized, no token provided",
    });
  }

  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is missing from environment variables");
    return res.status(503).json({
      message: "Authentication service is not configured.",
    });
  }

  try {
    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        message: "Not authorized, no token provided",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = await User.findById(decoded.id).select("-password");

    if (!req.user) {
      return res.status(401).json({
        message: "User belonging to this token no longer exists",
      });
    }

    return next();
  } catch (error) {
    console.error("Auth Middleware Error:", error.message);

    return res.status(401).json({
      message: "Not authorized, token invalid",
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: `User role '${req.user?.role || "unknown"}' is not authorized to access this route`,
      });
    }

    return next();
  };
};

module.exports = { protect, authorize };
