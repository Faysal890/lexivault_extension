# Lexora REST API

Base URL: `/api/v1`

All `/api/v1/*` endpoints accept either a NextAuth session cookie (used by the web app)
or a personal API key sent as `Authorization: Bearer lx_<prefix>_<secret>` (used by the
mobile app and browser extension). Public bootstrap endpoints (auth, password reset,
verify email, store webhook) require neither. The endpoints under `/api/v1/api-keys`
intentionally reject Bearer auth — a leaked key cannot mint or revoke other keys.

CORS is enabled (`Access-Control-Allow-Origin: *`) on every `/api/v1/*` route to allow
external clients. `Access-Control-Allow-Credentials` is **not** set, so the wildcard
origin is safe — cookies cannot be replayed cross-origin.

## Conventions

### Response envelope

Every JSON response uses one of two shapes:

```json
// Success
{ "data": <payload>, "meta": { ... } }

// Failure
{ "error": { "code": "NOT_FOUND", "message": "Word not found", "details": { ... } } }
```

`204 No Content` responses have no body.

### Error codes

| HTTP | `code`              | Meaning                                  |
|-----:|---------------------|------------------------------------------|
| 400  | `BAD_REQUEST`       | Malformed request or invalid state       |
| 401  | `UNAUTHORIZED`      | Missing or invalid session               |
| 403  | `FORBIDDEN`         | Authenticated but not allowed            |
| 404  | `NOT_FOUND`         | Resource does not exist                  |
| 409  | `CONFLICT`          | Duplicate resource (e.g., email in use)  |
| 422  | `VALIDATION_ERROR`  | Input failed schema validation; `details` carries the zod flatten output |
| 429  | `RATE_LIMITED`      | Upstream/AI quota exceeded               |
| 500  | `INTERNAL_ERROR`    | Unhandled server error                   |
| 502  | `DEPENDENCY_ERROR`  | Upstream service failed                  |

### Authentication

NextAuth manages the session. The browser flow is:

1. `POST /api/v1/auth/register` — create account, sends verification email
2. Click the verification link → `GET /api/v1/auth/verify-email?token=...`
3. `POST /api/auth/callback/credentials` — NextAuth login (managed by `next-auth/react`'s `signIn()`)
4. All `/api/v1/*` calls now succeed via the session cookie

`POST /api/auth/signin` and `POST /api/auth/signout` are NextAuth-managed and live
outside the `/api/v1` namespace.

#### API keys (mobile / extension flow)

External clients should use API keys instead of cookies:

1. The user signs in to the web app and visits **Profile → API Keys**.
2. They create a key, name it (e.g. "iPhone app") and optionally set an expiry.
3. The raw key is shown **once** in the form `lx_<prefix>_<secret>` — the server only
   stores a SHA-256 hash, so a lost key cannot be recovered, only revoked.
4. The client sends every request with `Authorization: Bearer lx_<prefix>_<secret>`.

API keys inherit the role of the user that created them (e.g. an `ADMIN` user's key
can call admin endpoints). They are rejected on `/api/v1/api-keys/*` to prevent a
leaked key from minting more keys.

---

## Resources

- [Auth](#auth)
- [Words](#words)
- [Quiz](#quiz)
- [Stats](#stats)
- [Profile](#profile)
- [API Keys](#api-keys)

---

## Auth

### `POST /api/v1/auth/register`

Create a new account and trigger a verification email. Returns 201.

**Body**
```json
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "password": "supersecret",
  "nativeLanguage": "Bengali"
}
```

**201**
```json
{
  "data": {
    "message": "Account created! Please check your email to verify your account.",
    "devVerifyUrl": "http://localhost:3000/verify-email?token=..."
  }
}
```
`devVerifyUrl` is only present when `NODE_ENV=development`.

**409** — `CONFLICT` if email already in use.

---

### `GET /api/v1/auth/verify-email?token=<hex64>`

Confirms the user's email. Idempotent — re-clicking a used link for an already-verified account succeeds.

**200**
```json
{ "data": { "message": "Email verified successfully!" } }
```

**400** — Invalid, used, or expired token.

---

### `POST /api/v1/auth/resend-verification`

Re-issues a fresh verification token; previous unused tokens are invalidated.
Always returns 200, even if the email is unknown or already verified
(prevents account enumeration).

**Body**
```json
{ "email": "ada@example.com" }
```

**200**
```json
{ "data": { "message": "Verification email sent." } }
```

---

### `POST /api/v1/auth/forgot-password`

Sends a password-reset email. Always returns 200.

**Body**
```json
{ "email": "ada@example.com" }
```

**200**
```json
{ "data": { "message": "If that email is registered, you'll receive a reset link shortly." } }
```

---

### `POST /api/v1/auth/reset-password`

Resets the password using a token from the reset email. Tokens are single-use and expire after 1 hour.

**Body**
```json
{
  "token": "<64 hex chars>",
  "password": "newSecret123"
}
```

**200**
```json
{ "data": { "message": "Password updated successfully." } }
```

**400** — Invalid, used, or expired token.

---

## Words

### `GET /api/v1/words`

List the authenticated user's words, newest first. Optional filters via query string.

**Query**
- `q` — substring match against `englishWord`
- `tag` — substring match against the comma-separated `tags` field

**200**
```json
{
  "data": [
    {
      "id": "clx...",
      "userId": "clx...",
      "englishWord": "ephemeral",
      "meaning": "ক্ষণস্থায়ী",
      "exampleSentence": "The beauty of a sunset is ephemeral.",
      "difficultyLevel": 2,
      "tags": "academic,IELTS",
      "createdAt": "2026-04-27T10:12:34.000Z",
      "updatedAt": "2026-04-27T10:12:34.000Z",
      "wordStats": {
        "correctCount": 4,
        "wrongCount": 1,
        "lastReviewed": "2026-04-26T08:00:00.000Z",
        "nextReview": "2026-05-03T08:00:00.000Z",
        "easeFactor": 2.6
      }
    }
  ]
}
```

---

### `POST /api/v1/words`

Create a new word. Awards +5 XP via the streak service.

**Body**
```json
{
  "englishWord": "ephemeral",
  "meaning": "ক্ষণস্থায়ী",
  "exampleSentence": "",
  "difficultyLevel": 2,
  "tags": "academic,IELTS"
}
```
- `englishWord` — required, 1–100 chars
- `meaning` — required, 1–500 chars
- `exampleSentence` — optional, ≤500 chars
- `difficultyLevel` — 1 (Easy) | 2 (Medium) | 3 (Hard); default 1
- `tags` — comma-separated, ≤200 chars

**201** — returns the created word.

**422** — `VALIDATION_ERROR` if input fails schema.

---

### `GET /api/v1/words/:id`

Get a single word (with stats) owned by the current user.

**200** — same shape as a list entry.
**404** — `NOT_FOUND`.

---

### `PUT /api/v1/words/:id`

Partial update. All fields optional. An empty `exampleSentence` clears it.

**200** — returns the updated word.
**404** — `NOT_FOUND`.

---

### `DELETE /api/v1/words/:id`

Deletes the word and its stats / quiz-question references.

**204** — no body.
**404** — `NOT_FOUND`.

---

### `POST /api/v1/words/:id/generate-example`

Asks the AI provider for an example sentence. **Never overwrites a user-provided sentence** —
returns `{ generated: false }` if one already exists.

**200**
```json
{ "data": { "generated": true, "sentence": "The beauty of a sunset is ephemeral." } }
```
or
```json
{ "data": { "generated": false } }
```

**429** — `RATE_LIMITED` when the AI provider returned a quota error.
**502** — `DEPENDENCY_ERROR` for any other AI failure.

---

## Quiz

### `GET /api/v1/quiz/generate`

Generates an in-memory quiz (does not persist anything). Words are sorted by SRS due-date,
then by accuracy ascending — weakest words come first. Returns `[]` if the user has fewer
than 2 words.

**Query**
- `type` — `mixed` (default) | `multiple_choice` | `fill_blank` | `reverse`
- `size` — 5–20, default 10

**200**
```json
{
  "data": [
    {
      "wordId": "clx...",
      "word": "ephemeral",
      "meaning": "ক্ষণস্থায়ী",
      "questionType": "multiple_choice",
      "question": "Which word means: \"ক্ষণস্থায়ী\"?",
      "options": ["ephemeral", "robust", "candid", "vivid"],
      "correctAnswer": "ephemeral"
    }
  ]
}
```
`fill_blank` questions omit `options`.

---

### `POST /api/v1/quiz/submit`

Records the quiz, applies SM-2 spaced-repetition updates to every answered word, and awards XP
(`score × 10`, ×1.5 if accuracy ≥ 80%).

**Body**
```json
{
  "quizType": "mixed",
  "score": 8,
  "totalQuestions": 10,
  "timeTaken": 124,
  "questions": [
    {
      "wordId": "clx...",
      "questionType": "multiple_choice",
      "userAnswer": "ephemeral",
      "correctAnswer": "ephemeral",
      "isCorrect": true,
      "options": ["ephemeral", "robust", "candid", "vivid"]
    }
  ]
}
```

**201**
```json
{ "data": { "quizId": "clx...", "xpGained": 120 } }
```

---

## Stats

### `GET /api/v1/stats`

Returns the user's aggregate stats summary.

**200**
```json
{
  "data": {
    "currentStreak": 7,
    "longestStreak": 12,
    "totalXP": 1240,
    "level": 13,
    "totalWords": 184,
    "masteredWords": 42,
    "totalQuizzes": 19,
    "avgAccuracy": 78
  }
}
```

---

## Profile

### `GET /api/v1/profile`

**200**
```json
{
  "data": {
    "id": "clx...",
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "nativeLanguage": "Bengali",
    "dailyGoal": 10,
    "createdAt": "2026-01-12T08:00:00.000Z"
  }
}
```

---

### `PUT /api/v1/profile`

Update the user's profile. All fields optional.

**Body**
```json
{
  "name": "Ada L.",
  "nativeLanguage": "Hindi",
  "dailyGoal": 15
}
```

**200** — returns the updated profile.

---

### `POST /api/v1/profile/change-password`

Change password while signed in. Verifies the current password first.

**Body**
```json
{
  "currentPassword": "...",
  "newPassword": "...",
  "confirmPassword": "..."
}
```

**200**
```json
{ "data": { "message": "Password changed successfully." } }
```
**400** — `BAD_REQUEST` if the current password is wrong.
**422** — `VALIDATION_ERROR` if `newPassword !== confirmPassword`.

---

## API Keys

These endpoints are **session-only** — they reject `Authorization: Bearer` so a leaked
key cannot mint or destroy other keys.

### `GET /api/v1/api-keys`

List the current user's API keys (active, expired, and revoked). The raw secret is
never returned — only the prefix and metadata.

**200**
```json
{
  "data": [
    {
      "id": "clx...",
      "name": "iPhone app",
      "prefix": "lx_a3f1c204",
      "scopes": "read,write",
      "lastUsedAt": "2026-04-30T08:12:34.000Z",
      "expiresAt": null,
      "revokedAt": null,
      "createdAt": "2026-04-12T10:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/v1/api-keys`

Create a new API key. The full raw key is returned **once** — the server only stores
a SHA-256 hash. Rate-limited to 5 creations per minute per user.

**Body**
```json
{
  "name": "iPhone app",
  "expiresInDays": 90
}
```
- `name` — required, 1–60 chars
- `expiresInDays` — optional, 1–365; omit for a key that never expires

**201**
```json
{
  "data": {
    "id": "clx...",
    "name": "iPhone app",
    "prefix": "lx_a3f1c204",
    "scopes": "read,write",
    "lastUsedAt": null,
    "expiresAt": "2026-07-30T08:12:34.000Z",
    "revokedAt": null,
    "createdAt": "2026-04-30T08:12:34.000Z",
    "raw": "lx_a3f1c204_<48 hex chars>"
  }
}
```

**429** — `RATE_LIMITED` if the user has created more than 5 keys in the last minute.

---

### `DELETE /api/v1/api-keys/:id`

Revoke a key. Idempotent — revoking an already-revoked key still returns 204. The
key stops working immediately on the next request.

**204** — no body.
**404** — `NOT_FOUND` if the key does not belong to the current user.
