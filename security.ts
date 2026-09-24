// src/lib/security.ts
// Shared security utilities — imported by api/ serverless functions
//
// What this file does:
//   1. Rate limiting  — limits how many requests one IP can make per hour
//   2. Input sanitization — strips dangerous characters from user input
//   3. CORS validation — only allows your own domain to call these endpoints
//   4. Request size guard — blocks oversized payloads
// ─────────────────────────────────────────────────────────────────────────────
 
// ── 1. IN-MEMORY RATE LIMITER ─────────────────────────────────────────────────
//
// How it works:
//   - We keep a Map in memory: { "ip_address" → { count, resetTime } }
//   - Every request from an IP increments its counter
//   - When resetTime passes, the counter resets to 0
//   - If count exceeds the limit → return 429 Too Many Requests
//
// Limitation: This resets when Vercel cold-starts the function.
// For production at scale you would use Redis (e.g. Upstash) instead.
// For a personal/portfolio app this is perfectly sufficient.

interface RateLimitEntry {
    count: number;
    resetTime: number; // unix timestamp ms when window reset

}

// seperate stores per endpoint so weather and Ai have independent limit.
const stores: Record<string, Map<string, RateLimitEntry>> = {};

// is store is present about the parmeter name get the store 
// else set the stores by th parameter name assign a map{} to the store with provided name 
function getStore(name: string): Map<string, RateLimitEntry> {
    if(!stores[name]) stores[name] = new Map();
    return stores[name];
}


export interface RateLimitConfig {
    store: string; // e.g "weather" | "chat"
    maxRequests: number; // how many request allowed
    windowMs: number; // time window in miliseconds

}

export const RATE_LIMIT_BASIC: RateLimitConfig = {
    store: "basic",
    maxRequests: 50,
    windowMs: 60 * 60 * 100,  // 1 hour
};


// strict config request per hour for AI endpoint

export const RATE_LIMIT_STRICT: RateLimitConfig = {
    store: "strict",
    maxRequests: 20,
    windowMs: 60 * 60 * 100, // 1 hour
} 

export interface RateLimitResult {
   allowed: boolean;
   remainig: number;  // request left in this window
   resetIn: number;   // second until window reset
}

export function checkRateLimit(ip: string, config: RateLimitConfig): RateLimitResult {
    const store = getStore(config.store);
    const now = Date.now();
    const entry = store.get(ip);

    // first request from this ip or window has expired = reset
    if(!entry || now > entry.resetTime){
       store.set(ip, {count: 1, resetTime: now + config.windowMs});

       return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetIn: Math.ceil(config.windowMs / 1000),
       };

    }

    // window still active
    if(entry.count >= config.maxRequests){
        return {
            allowed: false,
            remaining: 0,
            resetIn: Math.ceil((entry.resetTime - now) / 1000),
        };
    }

    // increment and allow
    entry.count += 1;
    store.set(ip, entry);
    
    return {
        allowed: true,
        remaining: config.maxRequests - entry.count,
        resetIn: Math.ceil((entry.resetTime - now) / 1000), 
    };
}


// clean up old entries everyHour to prevent memory leaks 
setInterval(() => {
    const now = Date.now();
    for(const store of Object.values(stores)){
        for(const [ip, entry] of store.entries()){
            if(now > entry.resetTime) store.delete(ip);
        }
    }
}, 60 * 60 * 1000);



// get client ip
// Vercel passes the real client IP in x-forwarded-for header.
// We always use the first IP in the chain — that is the actual client.
// Falling back to "unknown" means unknown IPs share one rate limit bucket.

export function getClientIp(headers: Record<string, string | string[] | undefined>): string {

    const forwarded = headers["x-forwarded-for"];
    if(Array.isArray(forwarded)) return forwarded[0].split(",")[0].trim();
    if(typeof forwarded === "string") return forwarded.split(",")[0].trim();
    return "unknown";
} 


// ── 3. CORS VALIDATION ────────────────────────────────────────────────────────
//
// CORS = Cross-Origin Resource Sharing
// This prevents OTHER websites from calling your /api/ endpoints.
// Without this anyone could embed your app's backend in their site.
//
// How it works:
//   - Browser sends "Origin" header with every request
//   - We check it against our allowed list
//   - If it matches → set Access-Control-Allow-Origin header
//   - If it doesn't match → return 403 Forbidden

const ALLOWED_ORIGINS: string[] = [
    // Add your Vercel URL here after deployment:
  // "https://your-app.vercel.app",
 
  // Local development:
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "https://myvercelapp.vercel.app",
];

export function isAllowedOrigin(origin: string | undefined): boolean {
    if(!origin) return false; // no origin server-to-server = block

    // in development allow all localhost origins
    if(process.env.NODE_ENV === "development") return true;


    
    return ALLOWED_ORIGINS.includes(origin);
}


export function getCorsHeaders(origin: string | undefined): Record<string, string> {

    const allowed = isAllowedOrigin(origin);

    return {
       "Access-Control-Allow-Origin": allowed ? (origin ?? "") : "",
       "Access-Control-Allow-Methods": "GET", "POST", "OPTIONS",
       "Access-Control-Allow-Headers": "Content-Type",
       "Access-Control-Max-Age":  "86400", // preflight cache 24hr
    };
}

// input sanitization
// Never trust user input. We strip:
//   - HTML tags  → prevents XSS if output is ever rendered as HTML
//   - Null bytes → prevents certain injection attacks
//   - Excessive whitespace → normalizes input
//
// We also enforce a max length to prevent oversized inputs.

export function sanitizeLocation(input: unknown): string | null {
    if(typeof input !== "string") return null;
    const cleaned = input.replace(/<[^>]*>/g, "") // strip html tags
    .replace(/\0/g, "")  // stripe null
    .trim()
    .slice(0, 100);    // max 100 chars for city name 
    
    if(cleaned.length < 1) return null;
    return cleaned;
}


export function sanitizeMessages(input: unknown): Array<{role: string; content: string}> | null {
    if(!Array.isArray(input)) return null;
    if(input.length > 50) return null;  // max 50 mesages in conversation

    const messages = input.map(m => {
        if(typeof m !== "object" || m === null) return null;

        const msg = m as Record<string, unknown>;
        if(msg.role !== "user" && msg.role !== "model") return null;
        if(typeof msg.content !== "string") return null;

        return {
            role: msg.role as string,
            content: msg.content.replace(/<[^>]*>/g, "").replace(/\0/g, "").slice(0, 2000),

        };
    });

    if(messages.some(m => m === null)) return null;
    return messages as Array<{role: string; content: string}>;
}


// ── 5. SECURITY RESPONSE HEADERS ─────────────────────────────────────────────
//
// These HTTP headers tell browsers how to behave securely with your app.
// Each one explained:
 
export const SECURITY_HEADERS: Record<string, string> = {
  // Prevents browsers from sniffing the content type
  "X-Content-Type-Options": "nosniff",
 
  // Prevents your app from being embedded in iframes on other sites (clickjacking)
  "X-Frame-Options": "DENY",
 
  // Enables browser's built-in XSS filter
  "X-XSS-Protection": "1; mode=block",
 
  // Tells browsers to only use HTTPS, never HTTP (HSTS)
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
 
  // Controls what information is sent in the Referer header
  "Referrer-Policy": "strict-origin-when-cross-origin",
 
  // Prevents loading resources from unexpected origins (CSP)
  "Content-Security-Policy": [
    "default-src 'self'",
    "connect-src 'self' https://weather.visualcrossing.com https://generativelanguage.googleapis.com https://*.basemaps.cartocdn.com",
    "img-src 'self' data: https://unpkg.com https://*.cartocdn.com",
    // "script-src 'self' 'unsafe-inline'",  // needed for Vite dev
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
  ].join("; "),
};
 
