const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Allow known frontend origins. CLIENT_URL / CLIENT_URLS may contain
// one or multiple comma-separated production URLs.
const configuredOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://lostfound-frontend-liard.vercel.app',
  ...(process.env.CLIENT_URLS || '').split(','),
  process.env.CLIENT_URL,
  process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : null
]
  .filter(Boolean)
  .map((origin) => origin.trim().replace(/\/$/, ''));

const allowedOrigins = new Set(configuredOrigins);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }

    const error = new Error('Origin is not allowed by CORS');
    error.status = 403;
    return callback(error);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

// Image scanner sends Base64 data, so keep a sufficient but bounded limit.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({
  extended: true,
  limit: '10mb'
}));

// Health endpoint does not depend on MongoDB, so hosting providers can
// confirm that the serverless function itself is alive.
app.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'Lost & Found Engine Running'
  });
});

// Reuse the cached MongoDB connection for concurrent/warm requests.
app.use(async (req, res, next) => {
  try {
    await connectDB();
    return next();
  } catch (error) {
    console.error('Database Connection Failed:', error.message);

    return res.status(503).json({
      success: false,
      message: 'Database connection failed. Please try again.',
    });
  }
});

app.get('/api/health', (req, res) => {
  return res.status(200).json({
    success: true,
    database: 'connected'
  });
});

// API ROUTES
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/items', require('./routes/itemRoutes'));
app.use('/api/claims', require('./routes/claimRoutes'));
app.use('/api/ai', require('./routes/aiRoutes'));

// NOT FOUND
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: 'API route not found'
  });
});

// GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error('Global Server Error:', err);

  if (res.headersSent) {
    return next(err);
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Request payload is too large.'
    });
  }

  return res.status(err.status || 500).json({
    success: false,
    message: err.status === 403
      ? 'Request origin is not allowed.'
      : 'Internal Server Error'
  });
});

// Local development only. Vercel imports the app without opening a port.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
