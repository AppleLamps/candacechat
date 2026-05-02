import { NextResponse } from "next/server";
import { DEFAULT_MODEL } from "@/lib/defaults";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/system-prompt";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  role: ChatRole;
  content: string;
  imageUrls?: string[];
  files?: ChatFile[];
  annotations?: unknown[];
};

type ChatFile = {
  filename: string;
  fileData: string;
};

type OpenRouterContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      imageUrl: {
        url: string;
      };
    }
  | {
      type: "file";
      file: {
        filename: string;
        fileData: string;
      };
    };

type OpenRouterMessage = {
  role: ChatRole;
  content: string | OpenRouterContent[];
  annotations?: unknown[];
};

type ChatRequest = {
  model?: string;
  responseMode?: "standard" | "extended";
  messages?: ChatMessage[];
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_MESSAGES = 512;
const MAX_MESSAGE_CHARS = 1_000_000;
const MAX_SYSTEM_PROMPT_CHARS = 300_000;
const MAX_TOTAL_CONTENT_CHARS = 3_800_000;
const SUPPORTED_IMAGE_DATA_URL_PATTERN =
  /^data:(image\/png|image\/jpeg|image\/webp|image\/gif);base64,/i;
const SUPPORTED_PDF_DATA_URL_PATTERN = /^data:application\/pdf;base64,/i;

function isPublicUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isSupportedImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const url = value.trim();

  if (SUPPORTED_IMAGE_DATA_URL_PATTERN.test(url)) return true;
  return isPublicUrl(url);
}

function isSupportedPdfFile(value: unknown): value is ChatFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatFile>;

  if (
    typeof candidate.filename !== "string" ||
    candidate.filename.trim().length === 0 ||
    typeof candidate.fileData !== "string"
  ) {
    return false;
  }

  const fileData = candidate.fileData.trim();

  return SUPPORTED_PDF_DATA_URL_PATTERN.test(fileData) || isPublicUrl(fileData);
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatMessage>;
  const imageUrls = Array.isArray(candidate.imageUrls)
    ? candidate.imageUrls.filter(isSupportedImageUrl)
    : undefined;
  const files = Array.isArray(candidate.files)
    ? candidate.files.filter(isSupportedPdfFile)
    : undefined;

  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0 &&
    (!candidate.imageUrls || imageUrls?.length === candidate.imageUrls.length) &&
    (!candidate.files || files?.length === candidate.files.length) &&
    (!candidate.annotations || Array.isArray(candidate.annotations))
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

function contentLength(messages: ChatMessage[]) {
  return messages.reduce(
    (total, message) =>
      total +
      message.content.length +
      (message.imageUrls || []).reduce(
        (imageTotal, imageUrl) => imageTotal + imageUrl.length,
        0
      ) +
      (message.files || []).reduce(
        (fileTotal, file) => fileTotal + file.fileData.length,
        0
      ),
    0
  );
}

function messageLength(message: ChatMessage) {
  return (
    message.content.length +
    (message.imageUrls || []).reduce(
      (total, imageUrl) => total + imageUrl.length,
      0
    ) +
    (message.files || []).reduce(
      (total, file) => total + file.fileData.length,
      0
    )
  );
}

function requestLimitError(systemPrompt: string, messages: ChatMessage[]) {
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    return `System prompt is too large. Keep it under ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters.`;
  }

  if (messages.length > MAX_MESSAGES) {
    return `Too many messages. Keep the request under ${MAX_MESSAGES.toLocaleString()} messages.`;
  }

  const oversizedMessage = messages.find(
    (message) => messageLength(message) > MAX_MESSAGE_CHARS
  );

  if (oversizedMessage) {
    return `One message plus its attachments is too large. Keep each message under ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`;
  }

  const totalCharacters = systemPrompt.length + contentLength(messages);

  if (totalCharacters > MAX_TOTAL_CONTENT_CHARS) {
    return `Conversation is too large to send at once. Keep the request under ${MAX_TOTAL_CONTENT_CHARS.toLocaleString()} characters.`;
  }

  return null;
}

function toOpenRouterMessage(message: ChatMessage): OpenRouterMessage {
  const imageUrls =
    message.role === "user"
      ? (message.imageUrls || []).filter(isSupportedImageUrl)
      : [];
  const files =
    message.role === "user"
      ? (message.files || []).filter(isSupportedPdfFile)
      : [];

  if (imageUrls.length === 0 && files.length === 0) {
    return {
      role: message.role,
      content: message.content,
      annotations: message.annotations
    };
  }

  return {
    role: message.role,
    content: [
      { type: "text", text: message.content },
      ...imageUrls.map((url) => ({
        type: "image_url" as const,
        imageUrl: { url }
      })),
      ...files.map((file) => ({
        type: "file" as const,
        file: {
          filename: file.filename,
          fileData: file.fileData
        }
      }))
    ],
    annotations: message.annotations
  };
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

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : DEFAULT_MODEL;
  const responseMode = body.responseMode === "extended" ? "extended" : "standard";
  const systemPrompt = DEFAULT_SYSTEM_PROMPT;
  const clientMessages = Array.isArray(body.messages)
    ? body.messages.filter(isChatMessage)
    : [];

  if (!model) {
    return NextResponse.json({ error: "Model is required." }, { status: 400 });
  }

  if (clientMessages.length === 0) {
    return NextResponse.json(
      { error: "At least one user message is required." },
      { status: 400 }
    );
  }

  const limitError = requestLimitError(systemPrompt, clientMessages);

  if (limitError) {
    return NextResponse.json({ error: limitError }, { status: 413 });
  }

  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt },
    ...(responseMode === "extended"
      ? [
          {
            role: "system" as const,
            content:
              "For this response, use extended mode: be more complete, develop the argument, and include useful detail while staying in the requested voice."
          }
        ]
      : []),
    ...clientMessages.map(toOpenRouterMessage)
  ];
  const hasPdfFiles = clientMessages.some((message) => message.files?.length);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "X-OpenRouter-Cache": "true",
    "X-OpenRouter-Cache-TTL":
      process.env.OPENROUTER_CACHE_TTL_SECONDS || "300"
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
        max_tokens: responseMode === "extended" ? 8192 : 2048,
        ...(hasPdfFiles
          ? {
              plugins: [
                {
                  id: "file-parser",
                  pdf: {
                    engine: "cloudflare-ai"
                  }
                }
              ]
            }
          : {}),
        stream: false
      })
    });

    const data = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string; annotations?: unknown[] } }>;
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

    return NextResponse.json({
      reply,
      annotations: data.choices?.[0]?.message?.annotations,
      cache: {
        status: response.headers.get("X-OpenRouter-Cache-Status"),
        age: response.headers.get("X-OpenRouter-Cache-Age"),
        ttl: response.headers.get("X-OpenRouter-Cache-TTL"),
        generationId: response.headers.get("X-Generation-Id")
      }
    });
  } catch {
    return NextResponse.json(
      { error: "Network error while contacting OpenRouter." },
      { status: 502 }
    );
  }
}
