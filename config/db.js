
const mongoose = require('mongoose');

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = {
    conn: null,
    promise: null
  };
}

const connectDB = async () => {
  // Already connected
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is missing from environment variables');
  }

  // Reset stale connection cache
  if (
    mongoose.connection.readyState === 0 ||
    mongoose.connection.readyState === 3
  ) {
    cached.conn = null;
    cached.promise = null;
  }

  // Create a new connection only when needed
  if (!cached.promise) {
    cached.promise = mongoose.connect(
      process.env.MONGO_URI,
      {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        bufferCommands: false
      }
    ).then((mongooseInstance) => {
      console.log(
        'MongoDB Connected:',
        mongooseInstance.connection.name
      );

      return mongooseInstance.connection;
    }).catch((error) => {
      cached.conn = null;
      cached.promise = null;

      console.error('MongoDB Connection Error:', error.message);

      throw error;
    });
  }

  try {
    cached.conn = await cached.promise;

    // Ensure connection is actually ready
    if (mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB connection is not ready');
    }

    return cached.conn;

  } catch (error) {
    cached.conn = null;
    cached.promise = null;

    throw error;
  }
};

module.exports = connectDB;
