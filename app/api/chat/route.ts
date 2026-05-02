import { NextResponse } from "next/server";
import { DEFAULT_MODEL } from "@/lib/defaults";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type ChatRequest = {
  model?: string;
  systemPrompt?: string;
  messages?: ChatMessage[];
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatMessage>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

function errorMessage(status: number, fallback?: string) {
  if (status === 400) {
    return "OpenRouter rejected the request. Check the model, messages, or system prompt.";
  }
  if (status === 401) {
    return "OpenRouter authentication failed. Check OPENROUTER_API_KEY in .env.local.";
  }
  if (status === 429) {
    return "OpenRouter rate limit reached. Wait a moment, then retry.";
  }
  if (status >= 500) {
    return "OpenRouter is having trouble right now. Please retry in a moment.";
  }
  return fallback || "The chat request failed.";
}

export async function POST(request: Request) {
  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Missing OPENROUTER_API_KEY. Add it to .env.local and restart the dev server."
      },
      { status: 500 }
    );
  }

  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const model = (body.model || DEFAULT_MODEL).trim();
  const systemPrompt = (body.systemPrompt || "").trim();
  const clientMessages = Array.isArray(body.messages)
    ? body.messages.filter(isChatMessage)
    : [];

  if (!model) {
    return NextResponse.json({ error: "Model is required." }, { status: 400 });
  }

  if (!systemPrompt) {
    return NextResponse.json(
      { error: "System prompt is required." },
      { status: 400 }
    );
  }

  if (clientMessages.length === 0) {
    return NextResponse.json(
      { error: "At least one user message is required." },
      { status: 400 }
    );
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...clientMessages
  ];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json"
  };

  if (process.env.OPENROUTER_SITE_URL) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  }

  if (process.env.OPENROUTER_APP_TITLE) {
    headers["X-OpenRouter-Title"] = process.env.OPENROUTER_APP_TITLE;
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false
      })
    });

    const data = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      return NextResponse.json(
        {
          error: errorMessage(response.status, data.error?.message),
          status: response.status
        },
        { status: response.status }
      );
    }

    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return NextResponse.json(
        { error: "OpenRouter returned no assistant content." },
        { status: 502 }
      );
    }

    return NextResponse.json({ reply });
  } catch {
    return NextResponse.json(
      { error: "Network error while contacting OpenRouter." },
      { status: 502 }
    );
  }
}
