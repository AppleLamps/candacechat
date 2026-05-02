# Candace Voice Chat

A polished light-mode Next.js chat app that calls OpenRouter securely from a
server route. The UI includes a responsive sidebar/header, editable system
prompt settings, session conversation history, loading and error states, retry,
and a multiline composer.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local`:

```bash
cp .env.example .env.local
```

3. Add your OpenRouter key:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

Optional attribution headers:

```bash
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_TITLE=Grift Owens Chat
```

## Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## Build

```bash
npm run build
```

## Deploy To Vercel

This project is configured for Vercel with `vercel.json` and a standard Next.js
App Router setup.

1. Push this project to GitHub.
2. In Vercel, choose **Add New Project** and import the repository.
3. Vercel should detect **Next.js** automatically. The included `vercel.json`
   sets:
   - Install command: `npm install`
   - Build command: `npm run build`
   - Development command: `npm run dev`
4. Add the required environment variable in Vercel:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

Optional attribution variables:

```bash
OPENROUTER_SITE_URL=https://your-vercel-domain.vercel.app
OPENROUTER_APP_TITLE=Grift Owens Chat
```

5. Deploy. The OpenRouter key is used only by the server route and is never
   exposed to the browser.

## OpenRouter Details

- Endpoint: `POST https://openrouter.ai/api/v1/chat/completions`
- Default model: `~google/gemini-flash-latest`
- The server route is `app/api/chat/route.ts`
- The API key is read only from `process.env.OPENROUTER_API_KEY`
- Client requests send `model`, `systemPrompt`, and the current session's
  `user` / `assistant` message history.
- The default editable system prompt is the full Candace Owens voice prompt in
  `lib/defaults.ts`.

