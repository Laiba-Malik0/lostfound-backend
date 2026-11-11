
const mongoose = require('mongoose');

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = {
    conn: null,
    promise: null
  };
}

const connectDB = async () => {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is missing from environment variables');
  }

  if (!cached.promise) {
    const options = {
      bufferCommands: false,
      serverSelectionTimeoutMS: 10000
    };

    cached.promise = mongoose.connect(
      process.env.MONGO_URI,
      options
    ).then((mongooseInstance) => {
      console.log(
        `MongoDB Connected: ${mongooseInstance.connection.name}`
      );

      return mongooseInstance;
    }).catch((error) => {
      cached.promise = null;
      cached.conn = null;
      throw error;
    });
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (error) {
    cached.promise = null;
    cached.conn = null;

    console.error('MongoDB Connection Error:', error.message);

    throw error;
  }
};

module.exports = connectDB;
