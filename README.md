# The-SecurityTool-serverless-Api
Security Tool For Serverless/Api /CORS/RateLimit/callerIp

security.ts
     │
     ├── Who is calling?       → getClientIp()
     ├── Too many requests?    → checkRateLimit()
     ├── Allowed website?      → isAllowedOrigin()
     ├── Safe input?           → sanitizeLocation()
     │                           sanitizeMessages()
     ├── Safe response?        → SECURITY_HEADERS

  Before I allow this request to reach my expensive/backend functionality, 
  let's check whether the request is acceptable.

1 RateLimitEntry interface

interface RateLimitEntry {
  count: number;
  resetTime: number;
}
An interface describes the shape of an object.
Every rate-limit record must have a (count) and a (resetTime), and both must be numbers.

```
const entry: RateLimitEntry = {
  count: 7,
  resetTime: 1780000000000
};
```

count : how many requests this IP made in current window
resetTime: the exact timestamp when the ip rate limit window expires.

//

2: stores
```
const stores: Record<
  string,
  Map<string, RateLimitEntry>
> = {};
```
This looks complicated, but it's a very useful architecture.
Map<string, RateLimitEntry>
One Map looks like:
IP address             RateLimitEntry
────────────────────────────────────────
"192.168.1.10"    →    { count: 4, resetTime: ... }
"10.0.0.5"        →    { count: 12, resetTime: ... }
"172.20.1.4"      →    { count: 2, resetTime: ... }

IP as string and RateLimitEntery as an Object.  Map can keep key values whatever it is in data
```
Map<key, value>    key = Ip  value = { count, resetTime }
```

Then Record<string, Map<...>>
You don't have just one Map.
You want separate rate limits for different purposes.
For example:
```
stores
│
├── "basic"
│      │
│      ├── IP A → { count: 4, resetTime: ... }
│      └── IP B → { count: 8, resetTime: ... }
│
└── "strict"
       │
       ├── IP A → { count: 2, resetTime: ... }
       └── IP B → { count: 19, resetTime: ... }
```
```
Record<string, Map<string, RateLimitEntry>>
```
represents.  The first string is:  "basic"    "strict"
The Map contains IP addresses.


3: getStore() 
```
function getStore(
  name: string
): Map<string, RateLimitEntry> {

  if (!stores[name])
    stores[name] = new Map();  // create  a new one for that particular name

  return stores[name];
}
```
This function means:
Give me the rate-limit Map associated with this name. If it doesn't exist yet, create it.
Suppose you call:
```
getStore("basic");
```

4: RateLimitConfig
```
export interface RateLimitConfig {
  store: string;
  maxRequests: number;
  windowMs: number;
}
```
This describes how a rate limiter should behave.
```
const config: RateLimitConfig = {
  store: "basic",
  maxRequests: 50,
  windowMs: 3600000
};
```
Means:
Use store:       basic
Allow:           50 requests
Window:          3600000 ms


5: RATE_LIMIT_BASIC
```
export const RATE_LIMIT_BASIC: RateLimitConfig = {
  store: "basic",
  maxRequests: 50,
  windowMs: 60 * 60 * 1000,
};
```
50 requests   within  1 hour

60 seconds
× 60 minutes
× 1000 milliseconds = 3600,000 miliseconds


6: RATE_LIMIT_STRICT
```
export const RATE_LIMIT_STRICT: RateLimitConfig = {
  store: "strict",
  maxRequests: 20,
  windowMs: 60 * 60 * 1000,
};
```
This creates another policy:
Basic API: 50 requests/hour

Strict API:  20 requests/hour
You could use:
APi → BASIC
AI      → STRICT

because AI requests are generally more expensive than a simple weather request.


7: RateLimitResult
```
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}
```
This describes what the rate limiter tells your API.
For example:
```
{
  allowed: true,
  remaining: 17,
  resetIn: 3200
}
```
Request is allowed. You have 17 requests remaining, and the window resets in 3,200 seconds.
```
{
allowed: false,
remainig: 0,
resetIn: 1200
}
```
Request is blocked retry after 1200 sec


7: checkRateLimit()  func
most important function in this file.
```
export function checkRateLimit(
  ip: string,
  config: RateLimitConfig
): RateLimitResult
```
It receives:  IP address +  rate-limit configuration       as parameter.
     ↓
rate-limit decision

store from getStore(config.store); 


8: Get current time
```
const now = Date.now();
```
Date.now() gives the current Unix timestamp in milliseconds.
For example:
1780000000000
You don't care about the actual human-readable date.
You care about comparing numbers:
now < resetTime
or:
now > resetTime

9: Find this IP
const entry = store.get(ip);

Suppose:

ip = "123.45.67.89";

The Map might contain:

"123.45.67.89"
        ↓
{
  count: 12,
  resetTime: 1780003600000
}
So:
```
entry
```
becomes:
```
{
  count: 12,
  resetTime: 1780003600000
}
```
If this is the first request:
entry === undefined


11. First request / expired window
```
if (!entry || now > entry.resetTime) {
```
This handles two situations.
Situation A — first request
```
!entry
```
is true.

Situation B — old window expired
```
now > entry.resetTime
```
is true.

either true create  a new window fresh
```
store.set(ip, {
count: 1,
resetTime: now + config.windowMs
});
```
Suppose
now = 10:00
window = 1 hour
Then:
resetTime = 11:00
and:
count = 1


12. Return result
```
return {
  allowed: true,
  remaining: config.maxRequests - 1,
  resetIn: Math.ceil(config.windowMs / 1000),
};
```
If max is 50:    50 - 1 = 49
So:
```
{
  allowed: true,
  remaining: 49
}
```
the first request is already counted


13. Window still active
If the first condition wasn't triggered
// window still active
Now you check:
if (entry.count >= config.maxRequests)
Suppose:
maxRequests = 50
count = 50
Then:
50 >= 50
is true
return
```
{
allowed: false,
remaining: 0,
resetIn: ...
}
```
my API respond 429 too many requests.

14. Increment request count
If the user hasn't reached the limit:
entry.count += 1;
For example:
count = 17
becomes:
count = 18
Then:
store.set(ip, entry);
updates the map

15. Return updated result
```
return {
  allowed: true,
  remaining: config.maxRequests - entry.count,
  resetIn: Math.ceil(
    (entry.resetTime - now) / 1000
  ),
};
````
If:
maxRequests = 50
count = 18
then:
remaining = 32
//

17. setInterval() cleanup
You have:
```
setInterval(() => {
  const now = Date.now();

  for (const store of Object.values(stores)) {
    for (const [ip, entry] of store.entries()) {
      if (now > entry.resetTime) {
        store.delete(ip);
      }
    }
  }
}, 60 * 60 * 1000);
```
This is a memory cleanup mechanism.

without this our Map wwould theoritically grow
IP 1
IP 2
IP 3
IP 4
...
IP 100,000
...

even after their rate-limit windows expire.

So every hour you scan:

stores
 ↓
each store
 ↓
each IP
 ↓
check resetTime
 ↓
expired?
 ↓
delete

19. getClientIp()
```
export function getClientIp(
  headers: Record<string, string | string[] | undefined>
): string
```
This function answers:
"Which client IP should I use for rate limiting?"
Your serverless function receives HTTP headers.
Among them may be:
x-forwarded-for: 203.0.113.25


20. Array case
You wrote:
```
if (Array.isArray(forwarded))
  return forwarded[0].split(",")[0].trim();
```
Suppose:
forwarded = [
  "203.0.113.25, 10.0.0.1"
];
Then:
forwarded[0]
gives:
203.0.113.25, 10.0.0.1
Then:
.split(",")
gives:
[
  "203.0.113.25",
  " 10.0.0.1"
]
Then:
[0]
gets:
203.0.113.25
And:
.trim()
removes whitespace.
//

21. String case
```
if (typeof forwarded === "string")
  return forwarded.split(",")[0].trim();
```
Same idea, but when the header is a normal string.

//

23. isAllowedOrigin()
Now we're moving to CORS.
```
export function isAllowedOrigin(
  origin: string | undefined
): boolean
```
Its job:
Decide whether the website making the browser request is an allowed origin.

//

No origin
```
if (!origin) return false;
```
This means:
If the request doesn't provide an Origin, reject it.
But your comment:
no origin server-to-server = block
is an important design choice, not a universal CORS rule.
Server-to-server requests often don't have an Origin header.
So this can block legitimate non-browser callers.
Whether that's desirable depends on your API architecture.

//

Development mode
```
if (process.env.NODE_ENV === "development")
  return true;
```
This says:
During development, allow requests regardless of origin.
This is convenient because your frontend might move between:
localhost:5173
localhost:4173
etc.
But understand the security consequence:
development
      ↓
CORS restriction effectively disabled


