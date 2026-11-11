const mongoose = require("mongoose");

// Reuse one MongoDB connection/promise inside a warm serverless instance.
// This prevents each incoming request from opening a separate connection.
const globalCache = global.__lostFoundMongo || {
  connection: null,
  promise: null,
};

global.__lostFoundMongo = globalCache;

const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is missing from environment variables");
  }

  if (mongoose.connection.readyState === 0 || mongoose.connection.readyState === 3) {
    globalCache.connection = null;
    globalCache.promise = null;
  }

  if (!globalCache.promise) {
    globalCache.promise = mongoose
      .connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 10,
        minPoolSize: 0,
        maxIdleTimeMS: 30000,
        bufferCommands: false,
      })
      .then((instance) => {
        console.log("MongoDB Connected:", instance.connection.name);
        return instance.connection;
      })
      .catch((error) => {
        globalCache.connection = null;
        globalCache.promise = null;
        console.error("MongoDB Connection Error:", error.message);
        throw error;
      });
  }

  try {
    globalCache.connection = await globalCache.promise;

    if (mongoose.connection.readyState !== 1) {
      throw new Error("MongoDB connection is not ready");
    }

    return globalCache.connection;
  } catch (error) {
    globalCache.connection = null;
    globalCache.promise = null;
    throw error;
  }
};

module.exports = connectDB;
