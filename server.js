
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const connectDB = require('./config/db');

const app = express();

// ==========================================
// 1. CORS CONFIGURATION
// ==========================================

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://lostfound-frontend-liard.vercel.app',
  process.env.CLIENT_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    console.log('Incoming Origin:', origin);

    // Allow requests without origin (Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.error('Blocked CORS Origin:', origin);

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// ==========================================
// 2. BODY PARSERS
// ==========================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "10mb",
}));

app.use(express.urlencoded({
  extended: true,
  limit: '10mb'
}));

// ==========================================
// 3. DATABASE CONNECTION MIDDLEWARE
// ==========================================

app.use(async (req, res, next) => {
  try {
    await connectDB();

    next();

  } catch (error) {
    console.error('Database Connection Failed:', error);

    return res.status(503).json({
      success: false,
      message: 'Database connection failed',
      error: error.message
    });
  }
});

// ==========================================
// 4. HEALTH CHECK ROUTE
// ==========================================

app.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'Lost & Found Engine Running Smoothly 🚀'
  });
});

// ==========================================
// 5. API ROUTES
// ==========================================

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/items', require('./routes/itemRoutes'));
app.use('/api/claims', require('./routes/claimRoutes'));
app.use('/api/ai', require('./routes/aiRoutes'));

// ==========================================
// 6. NOT FOUND HANDLER
// ==========================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: 'API route not found'
  });
});

// ==========================================
// 7. GLOBAL ERROR HANDLER
// ==========================================

app.use((err, req, res, next) => {
  console.error('Global Server Error:', err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

// ==========================================
// 8. LOCAL DEVELOPMENT SERVER
// ==========================================

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// ==========================================
// 9. VERCEL SERVERLESS EXPORT
// ==========================================

module.exports = app;
