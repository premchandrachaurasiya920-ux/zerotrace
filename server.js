/**
 * ZeroTrace Backend API Gateway & Reverse-Proxy Server
 * 
 * Production-grade Express.js backend server acting as a secure proxy bridge between:
 *  - Frontend Application (e.g., local server on port 5500)
 *  - Telegram Bot engine
 *  - Google Apps Script Web App database
 */

// ==========================================
// 1. Core Environment Configuration
// ==========================================
// Configure the target Google Apps Script Web App URL here
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbzXccIzU0D3Z-he9C6MHDPsqkPA_Hro22dIBosOQ6-n7ZG7WI8LqXogv0DFf4l5bL5rQw/exec";
const PORT = process.env.PORT || 3000;
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS, 10) || 15000; // 15s timeout default

// ==========================================
// 2. Import Dependencies
// ==========================================
const express = require('express');
const cors = require('cors');

// Initialize Express App
const app = express();

// ==========================================
// 3. Middleware Configuration
// ==========================================
// Strict Express JSON parsing middleware
app.use(express.json());

// Open CORS configuration to eliminate cross-origin blocking parameters between ports
app.use(cors({
  origin: '*', // Allows requests from any origin, including Port 5500 and Port 3000
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Logging middleware for monitoring requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Status: ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// ==========================================
// 4. Resilient Fetch Helper
// ==========================================
/**
 * Performs a fetch request to the upstream database (Google Apps Script) with a strict timeout.
 * Wraps execution inside an AbortController signal chain.
 * 
 * @param {string} url - The full destination URL
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        ...options.headers,
      }
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Common handler to execute proxy requests to Apps Script and catch errors gracefully.
 * 
 * @param {string} action - The action parameter for Google Apps Script
 * @param {object} queryParams - Additional query parameters to forward
 * @param {import('express').Response} res - Express response object
 */
async function handleProxyRequest(action, queryParams = {}, res) {
  // Check if APPS_SCRIPT_URL is configured
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === "YOUR_APPS_SCRIPT_URL_HERE") {
    console.error(`[Config Error] APPS_SCRIPT_URL is not set or using default value.`);
    res.status(500).json({
      status: "error",
      message: "Upstream database URL configuration missing"
    });
    return null;
  }

  try {
    // Construct the target URL with query parameters
    const urlObj = new URL(APPS_SCRIPT_URL);
    urlObj.searchParams.append('action', action);
    
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        urlObj.searchParams.append(key, value);
      }
    }

    // Perform outbound fetch
    const response = await fetchWithTimeout(urlObj.toString());

    if (!response.ok) {
      throw new Error(`Upstream returned HTTP status ${response.status}`);
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      throw new Error(`Failed to parse upstream response as JSON. Content: ${text.slice(0, 100)}`);
    }

    return data;
  } catch (error) {
    // Gracefully capture internal logs without crashing the service loop
    console.error(`[Upstream Error] Action: ${action} | Error:`, error.message || error);
    
    // Return a clean error response as requested
    res.status(504).json({
      status: "error",
      message: "Upstream database sync timeout"
    });
    return null; // Signals to the handler that response was already sent
  }
}

// ==========================================
// 5. REST API Routes
// ==========================================

const apiRouter = express.Router();

/**
 * 1. GET /api/courses/home
 * Fetches the latest top releases for the landing grid.
 */
apiRouter.get('/courses/home', async (req, res) => {
  const data = await handleProxyRequest('getHome', {}, res);
  if (data !== null) {
    res.status(200).json(data);
  }
});

/**
 * 2. GET /api/courses/catalog
 * Fetches all catalog courses rows matrix database.
 */
apiRouter.get('/courses/catalog', async (req, res) => {
  const data = await handleProxyRequest('getCatalog', {}, res);
  if (data !== null) {
    res.status(200).json(data);
  }
});

/**
 * 3. GET /api/courses/post/:id
 * Retrieves a single item record mapped securely to a unique 10-character token identifier string.
 */
apiRouter.get('/courses/post/:id', async (req, res) => {
  const courseId = req.params.id;

  // Basic input validation: check if ID is present
  if (!courseId) {
    return res.status(400).json({ error: "Missing required route parameter: id" });
  }

  const data = await handleProxyRequest('getPostDetails', { id: courseId }, res);
  
  if (data !== null) {
    // If empty, null, or has error properties, return 404
    if (!data || Object.keys(data).length === 0 || data.error) {
      return res.status(404).json({
        error: "Course data record not found."
      });
    }
    res.status(200).json(data);
  }
});

/**
 * 4. GET /api/verify/check-id (CRITICAL BOT HOOK ROUTE)
 * Used by Telegram Bot system to prevent duplicate key assignments.
 * Expects ?id=10_CHAR_ID query parameter.
 */
apiRouter.get('/verify/check-id', async (req, res) => {
  const checkId = req.query.id;

  if (!checkId) {
    return res.status(400).json({
      error: "Missing required query parameter: id"
    });
  }

  const data = await handleProxyRequest('checkID', { id: checkId }, res);
  if (data !== null) {
    res.status(200).json(data);
  }
});

// Mount the API Router
app.use('/api', apiRouter);

// Base route for sanity checks
app.get('/', (req, res) => {
  res.status(200).json({
    status: "online",
    service: "ZeroTrace API Gateway Proxy",
    uptime: process.uptime()
  });
});

// Fallback for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: "Resource not found" });
});

// ==========================================
// 6. Server Init
// ==========================================
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(` ZeroTrace API Gateway running on port ${PORT}`);
  console.log(` Proxy Target: ${APPS_SCRIPT_URL}`);
  console.log(` Mode: Production-Grade Reverse-Proxy`);
  console.log(`=================================================`);
});

module.exports = app; // For testing/integration
