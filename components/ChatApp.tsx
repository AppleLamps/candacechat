"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DEFAULT_MODEL, SUGGESTED_PROMPTS } from "@/lib/defaults";

type Role = "user" | "assistant";

type Message = {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  imageAttachments?: ImageAttachment[];
  pdfAttachments?: PdfAttachment[];
  annotations?: unknown[];
  error?: boolean;
};

type ImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  url: string;
};

type PdfAttachment = {
  id: string;
  name: string;
  url: string;
};

type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  model: string;
  manualTitle?: boolean;
};

type ApiError = {
  error: string;
  status?: number;
};

type RequestMode = "standard" | "extended";

type SpeechRecognitionResultEventLike = Event & {
  results: {
    length: number;
    [index: number]: {
      length: number;
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
  };
};

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  abort: () => void;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

const exampleTitle = "Candace Chat";
const visibleModelName = "~gpt-candace-owens";
const STORAGE_KEY = "candace-chat-conversations-v1";
const SIDEBAR_STORAGE_KEY = "candace-chat-sidebar-v1";
const CLIENT_MAX_MESSAGES = 512;
const CLIENT_MAX_MESSAGE_CHARS = 1_000_000;
const CLIENT_MAX_REQUEST_CHARS = 3_600_000;
const MAX_TEXT_ATTACHMENT_CHARS = 500_000;
const MAX_IMAGE_DATA_URL_CHARS = 850_000;
const IMAGE_MAX_DIMENSION = 1400;
const IMAGE_COMPRESSION_QUALITY = 0.82;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);
const TEXT_ATTACHMENT_TYPES = new Set([
  "application/json",
  "application/xml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values"
]);

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function roleLabel(role: Role) {
  return role === "user" ? "You" : "Assistant";
}

function titleFromMessages(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = firstUserMessage?.content.trim().replace(/\s+/g, " ") || "New chat";
  return text.length > 52 ? `${text.slice(0, 49)}…` : text;
}

function sortConversations(conversations: Conversation[]) {
  return [...conversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

function trimMessagesForRequest(messages: Message[]) {
  const budget = CLIENT_MAX_REQUEST_CHARS;
  const selected: Message[] = [];
  let usedCharacters = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageSize =
      message.content.length +
      (message.imageAttachments || []).reduce(
        (total, image) => total + image.url.length,
        0
      ) +
      (message.pdfAttachments || []).reduce(
        (total, pdf) => total + pdf.url.length,
        0
      );

    if (messageSize > CLIENT_MAX_MESSAGE_CHARS) {
      throw new Error(
        `That attachment is too large to send. Try a smaller image, a public image URL, or a smaller PDF.`
      );
    }

    if (
      selected.length >= CLIENT_MAX_MESSAGES ||
      usedCharacters + messageSize > budget
    ) {
      break;
    }

    selected.unshift(message);
    usedCharacters += messageSize;
  }

  if (selected.length === 0 && messages.length > 0) {
    throw new Error("The newest message is too large to send.");
  }

  return {
    messages: selected,
    omittedCount: messages.length - selected.length,
    sentCharacters: usedCharacters
  };
}

function conversationTranscript(conversationTitle: string, messages: Message[]) {
  const transcript = messages
    .map((message) => {
      const label = roleLabel(message.role);
      const attachments = [
        ...(message.imageAttachments || []).map(
          (image) => `[Attached image: ${image.name}]`
        ),
        ...(message.pdfAttachments || []).map(
          (pdf) => `[Attached PDF: ${pdf.name}]`
        )
      ];
      const attachmentText = attachments.length
        ? `\n\n${attachments.join("\n")}`
        : "";

      return `${label} (${timeLabel(message.createdAt)}):\n${message.content}${attachmentText}`;
    })
    .join("\n\n---\n\n");

  return `# ${conversationTitle}\n\n${transcript}`;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function isTextAttachment(file: File) {
  return file.type.startsWith("text/") || TEXT_ATTACHMENT_TYPES.has(file.type);
}

function isImageAttachment(file: File) {
  return SUPPORTED_IMAGE_TYPES.has(file.type);
}

function isPdfAttachment(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error(`Could not read ${file.name}.`));
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not process that image."));
    image.src = dataUrl;
  });
}

async function readImageAsDataUrl(file: File) {
  const originalUrl = await readFileAsDataUrl(file);

  if (
    originalUrl.length <= MAX_IMAGE_DATA_URL_CHARS ||
    file.type === "image/gif"
  ) {
    return { url: originalUrl, mimeType: file.type };
  }

  const image = await loadImage(originalUrl);
  const scale = Math.min(
    1,
    IMAGE_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight)
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) return { url: originalUrl, mimeType: file.type };

  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  return {
    url: canvas.toDataURL("image/jpeg", IMAGE_COMPRESSION_QUALITY),
    mimeType: "image/jpeg"
  };
}

function isPdfUrl(url: URL) {
  return url.pathname.toLowerCase().endsWith(".pdf");
}

function fileFenceLanguage(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (!extension) return "text";

  if (["csv", "html", "json", "log", "md", "ts", "tsx", "txt", "xml"].includes(extension)) {
    return extension === "txt" ? "text" : extension;
  }

  return "text";
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Conversation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.model === "string" &&
    Array.isArray(candidate.messages)
  );
}

function stripPrivateConversationFields(conversation: Conversation) {
  const {
    systemPrompt: _systemPrompt,
    ...publicConversation
  } = conversation as Conversation & { systemPrompt?: string };

  return publicConversation;
}

export default function ChatApp() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState(uid);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [pendingPdfs, setPendingPdfs] = useState<PdfAttachment[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [requestMode, setRequestMode] = useState<RequestMode>("standard");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isReadingFiles, setIsReadingFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerNote, setComposerNote] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseInputRef = useRef("");

  const canSend =
    (input.trim().length > 0 ||
      pendingImages.length > 0 ||
      pendingPdfs.length > 0) &&
    !isSending &&
    !isReadingFiles;
  const lastAssistantErrored = messages[messages.length - 1]?.error === true;

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const storedSidebar = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      const parsed = stored ? (JSON.parse(stored) as unknown) : [];
      const saved = Array.isArray(parsed)
        ? sortConversations(
            parsed.filter(isConversation).map(stripPrivateConversationFields)
          )
        : [];

      if (storedSidebar) {
        setSidebarOpen(storedSidebar !== "collapsed");
      }

      if (saved.length > 0) {
        const latest = saved[0];
        setConversations(saved);
        setActiveConversationId(latest.id);
        setMessages(latest.messages);
        setModel(latest.model || DEFAULT_MODEL);
        setLastUserMessage(
          [...latest.messages].reverse().find((message) => message.role === "user")
            ?.content || null
        );
      }
    } catch {
      // Corrupt local storage should never block the chat UI.
      window.localStorage.removeItem(STORAGE_KEY);
    } finally {
      setHasHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hasHydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    window.localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      sidebarOpen ? "expanded" : "collapsed"
    );
  }, [sidebarOpen, hasHydrated]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages, isSending]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  function persistActiveConversation(nextMessages: Message[]) {
    if (nextMessages.length === 0) return;

    const now = new Date().toISOString();
    setConversations((current) => {
      const existing = current.find(
        (conversation) => conversation.id === activeConversationId
      );
      const title =
        existing?.manualTitle && existing.title
          ? existing.title
          : titleFromMessages(nextMessages);
      const nextConversation: Conversation = {
        id: activeConversationId,
        title,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        messages: nextMessages,
        model,
        manualTitle: existing?.manualTitle
      };

      return sortConversations([
        nextConversation,
        ...current.filter(
          (conversation) => conversation.id !== activeConversationId
        )
      ]);
    });
  }

  function openConversation(conversation: Conversation) {
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setModel(conversation.model || DEFAULT_MODEL);
    setInput("");
    setPendingImages([]);
    setPendingPdfs([]);
    setError(null);
    setLastUserMessage(
      [...conversation.messages].reverse().find((message) => message.role === "user")
        ?.content || null
    );
  }

  function startNewChat() {
    const id = uid();
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
      model
    };

    setConversations((current) => sortConversations([conversation, ...current]));
    setActiveConversationId(id);
    setMessages([]);
    setInput("");
    setPendingImages([]);
    setPendingPdfs([]);
    setError(null);
    setLastUserMessage(null);
    inputRef.current?.focus();
  }

  function deleteConversation(id: string) {
    const remaining = sortConversations(
      conversations.filter((conversation) => conversation.id !== id)
    );
    setConversations(remaining);

    if (id !== activeConversationId) return;

    const next = remaining[0];
    if (next) {
      openConversation(next);
      return;
    }

    startNewChat();
  }

  function renameConversation(id: string) {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;

    const nextTitle = window.prompt("Rename chat", conversation.title)?.trim();
    if (!nextTitle) return;

    setConversations((current) =>
      sortConversations(
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                title: nextTitle,
                manualTitle: true,
                updatedAt: new Date().toISOString()
              }
            : item
        )
      )
    );
  }

  async function sendMessage(
    content: string,
    retry = false,
    baseMessages = messages
  ) {
    const trimmed = content.trim();
    const imagesForMessage = retry ? [] : pendingImages;
    const pdfsForMessage = retry ? [] : pendingPdfs;
    const messageContent =
      trimmed ||
      (pdfsForMessage.length > 0
        ? "What are the main points in this document?"
        : "What's in this image?");

    if (
      (!trimmed && imagesForMessage.length === 0 && pdfsForMessage.length === 0) ||
      isSending
    ) {
      return;
    }

    setError(null);
    setComposerNote(null);
    setIsSending(true);
    setLastUserMessage(messageContent);

    const userMessage: Message = {
      id: uid(),
      role: "user",
      content: messageContent,
      createdAt: new Date().toISOString(),
      imageAttachments:
        imagesForMessage.length > 0 ? imagesForMessage : undefined,
      pdfAttachments: pdfsForMessage.length > 0 ? pdfsForMessage : undefined
    };

    const cleanMessages = baseMessages.filter((message) => !message.error);
    const optimisticMessages = retry ? cleanMessages : [...cleanMessages, userMessage];

    setMessages(optimisticMessages);
    persistActiveConversation(optimisticMessages);

    if (!retry) {
      setInput("");
      setPendingImages([]);
      setPendingPdfs([]);
    }

    try {
      const trimmedRequest = trimMessagesForRequest(optimisticMessages);
      const apiMessages = trimmedRequest.messages.map((message) => ({
        role: message.role,
        content: message.content,
        imageUrls:
          message.role === "user"
            ? message.imageAttachments?.map((image) => image.url)
            : undefined,
        files:
          message.role === "user"
            ? message.pdfAttachments?.map((pdf) => ({
                filename: pdf.name,
                fileData: pdf.url
              }))
            : undefined,
        annotations: message.annotations
      }));

      if (trimmedRequest.omittedCount > 0) {
        setComposerNote(
          `Sent the latest ${trimmedRequest.messages.length} messages (${trimmedRequest.sentCharacters.toLocaleString()} characters); ${trimmedRequest.omittedCount} older messages were outside the large-context budget.`
        );
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          responseMode: requestMode,
          messages: apiMessages
        })
      });

      const data = (await response.json().catch(() => ({}))) as
        | {
            reply?: string;
            annotations?: unknown[];
            cache?: { status?: string | null; ttl?: string | null };
          }
        | ApiError;

      if (!response.ok || "error" in data) {
        const message =
          "error" in data
            ? data.error
            : "The request failed. Please try again.";
        throw new Error(message);
      }

      const assistantMessage: Message = {
        id: uid(),
        role: "assistant",
        content: data.reply || "No response returned.",
        createdAt: new Date().toISOString(),
        annotations: "annotations" in data ? data.annotations : undefined
      };
      const finalMessages = [...optimisticMessages, assistantMessage];
      setMessages(finalMessages);
      persistActiveConversation(finalMessages);
      if ("cache" in data && data.cache?.status) {
        setComposerNote(
          `OpenRouter cache ${data.cache.status}${data.cache.ttl ? ` · TTL ${data.cache.ttl}s` : ""}.`
        );
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Something went wrong.";
      const errorMessage: Message = {
        id: uid(),
        role: "assistant",
        content: message,
        createdAt: new Date().toISOString(),
        error: true
      };
      const finalMessages = [...optimisticMessages, errorMessage];
      setError(message);
      setMessages(finalMessages);
      persistActiveConversation(finalMessages);
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void sendMessage(input);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  function retryLast() {
    if (!lastUserMessage) return;
    void sendMessage(lastUserMessage, true);
  }

  async function copyMessage(message: Message) {
    try {
      await copyText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId(null), 1500);
    } catch {
      setError("Could not copy that message.");
    }
  }

  function retryAssistantMessage(messageId: string) {
    const messageIndex = messages.findIndex((message) => message.id === messageId);
    if (messageIndex <= 0) return;

    const previousMessages = messages.slice(0, messageIndex);
    const previousUserMessage = [...previousMessages]
      .reverse()
      .find((message) => message.role === "user");

    if (!previousUserMessage) {
      setError("No user message found to retry.");
      return;
    }

    const nextMessages = previousMessages.filter((message) => !message.error);
    setMessages(nextMessages);
    persistActiveConversation(nextMessages);
    void sendMessage(previousUserMessage.content, true, nextMessages);
  }

  async function shareConversation() {
    if (messages.length === 0) {
      setComposerNote("Start a chat before sharing.");
      return;
    }

    const activeConversation = conversations.find(
      (conversation) => conversation.id === activeConversationId
    );
    const title = activeConversation?.title || titleFromMessages(messages);
    const text = conversationTranscript(title, messages);

    try {
      if (navigator.share) {
        await navigator.share({ title, text });
        setShareStatus("Shared");
      } else {
        await copyText(text);
        setShareStatus("Copied");
        setComposerNote("Conversation transcript copied to clipboard.");
      }

      window.setTimeout(() => setShareStatus(null), 1500);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError("Could not share this conversation.");
    }
  }

  async function addAttachments(files: FileList | null) {
    if (!files?.length) return;

    setIsReadingFiles(true);
    setError(null);

    try {
      const textBlocks: string[] = [];
      const imageBlocks: ImageAttachment[] = [];
      const pdfBlocks: PdfAttachment[] = [];

      for (const file of Array.from(files)) {
        if (isImageAttachment(file)) {
          const image = await readImageAsDataUrl(file);

          imageBlocks.push({
            id: uid(),
            name: file.name,
            mimeType: image.mimeType,
            url: image.url
          });
          continue;
        }

        if (isPdfAttachment(file)) {
          pdfBlocks.push({
            id: uid(),
            name: file.name,
            url: await readFileAsDataUrl(file)
          });
          continue;
        }

        if (isTextAttachment(file)) {
          const text = await file.text();
          const clipped =
            text.length > MAX_TEXT_ATTACHMENT_CHARS
              ? `${text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n\n[Truncated after ${MAX_TEXT_ATTACHMENT_CHARS.toLocaleString()} characters.]`
              : text;

          textBlocks.push(
            `Attached file: ${file.name}\n\n\`\`\`${fileFenceLanguage(file.name)}\n${clipped}\n\`\`\``
          );
          continue;
        }

        throw new Error(
          `${file.name} is not supported. Attach text files, PDFs, or PNG, JPEG, WebP, and GIF images.`
        );
      }

      if (textBlocks.length > 0) {
        setInput((current) =>
          [current.trim(), ...textBlocks].filter(Boolean).join("\n\n")
        );
      }

      if (imageBlocks.length > 0) {
        setPendingImages((current) => [...current, ...imageBlocks]);
      }

      if (pdfBlocks.length > 0) {
        setPendingPdfs((current) => [...current, ...pdfBlocks]);
      }

      const notes = [
        textBlocks.length > 0
          ? `${textBlocks.length.toLocaleString()} text attachment${textBlocks.length === 1 ? "" : "s"} added`
          : "",
        imageBlocks.length > 0
          ? `${imageBlocks.length.toLocaleString()} image attachment${imageBlocks.length === 1 ? "" : "s"} added`
          : "",
        pdfBlocks.length > 0
          ? `${pdfBlocks.length.toLocaleString()} PDF attachment${pdfBlocks.length === 1 ? "" : "s"} added`
          : ""
      ].filter(Boolean);

      if (notes.length > 0) {
        setComposerNote(`${notes.join(" and ")} to the prompt.`);
      }

      inputRef.current?.focus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that file.");
    } finally {
      setIsReadingFiles(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removePendingImage(id: string) {
    setPendingImages((current) => {
      const next = current.filter((image) => image.id !== id);

      if (next.length === 0 && pendingPdfs.length === 0) {
        setComposerNote(null);
      }

      return next;
    });
  }

  function removePendingPdf(id: string) {
    setPendingPdfs((current) => {
      const next = current.filter((pdf) => pdf.id !== id);

      if (next.length === 0 && pendingImages.length === 0) {
        setComposerNote(null);
      }

      return next;
    });
  }

  function addHostedImageUrl() {
    const url = window.prompt("Paste a public image or PDF URL")?.trim();

    if (!url) return;

    try {
      const parsed = new URL(url);

      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Use a public http or https image/PDF URL.");
      }

      if (isPdfUrl(parsed)) {
        setPendingPdfs((current) => [
          ...current,
          {
            id: uid(),
            name: parsed.pathname.split("/").pop() || "Hosted PDF",
            url
          }
        ]);
        setComposerNote("Hosted PDF URL added to the next message.");
      } else {
        setPendingImages((current) => [
          ...current,
          {
            id: uid(),
            name: parsed.pathname.split("/").pop() || "Hosted image",
            mimeType: "image/url",
            url
          }
        ]);
        setComposerNote("Hosted image URL added to the next message.");
      }
      inputRef.current?.focus();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That image/PDF URL is not valid."
      );
    }
  }

  function toggleVoiceInput() {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognitionConstructor =
      (window as SpeechRecognitionWindow).SpeechRecognition ||
      (window as SpeechRecognitionWindow).webkitSpeechRecognition;

    if (!SpeechRecognitionConstructor) {
      setComposerNote("Voice input is not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognitionConstructor();
    voiceBaseInputRef.current = input;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let transcript = "";

      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript || "";
      }

      if (transcript.trim()) {
        setInput(
          [voiceBaseInputRef.current.trim(), transcript.trim()]
            .filter(Boolean)
            .join(" ")
        );
      }
    };
    recognition.onerror = (event) => {
      setComposerNote(`Voice input stopped${event.error ? `: ${event.error}` : "."}`);
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setComposerNote("Listening...");
    setIsListening(true);
    recognition.start();
  }

  function resetChat() {
    startNewChat();
  }

  function openMobileConversation(conversation: Conversation) {
    openConversation(conversation);
    setMobileSidebarOpen(false);
  }

  function startMobileNewChat() {
    startNewChat();
    setMobileSidebarOpen(false);
  }

  return (
    <main className="flex h-screen overflow-hidden bg-white text-[#0d0d0d]">
      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close sidebar"
            className="absolute inset-0 bg-black/25"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-[280px] max-w-[86vw] flex-col border-r border-[#e8e8e8] bg-[#f9f9f9] shadow-[12px_0_40px_rgba(0,0,0,0.12)]">
            <SidebarPanel
              conversations={conversations}
              activeConversationId={activeConversationId}
              onNewChat={startMobileNewChat}
              onOpenConversation={openMobileConversation}
              onRenameConversation={renameConversation}
              onDeleteConversation={deleteConversation}
              onCollapse={() => setMobileSidebarOpen(false)}
              collapseLabel="Close sidebar"
            />
          </aside>
        </div>
      ) : null}

      {sidebarOpen ? (
        <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[#e8e8e8] bg-[#f9f9f9] md:flex">
          <SidebarPanel
            conversations={conversations}
            activeConversationId={activeConversationId}
            onNewChat={resetChat}
            onOpenConversation={openConversation}
            onRenameConversation={renameConversation}
            onDeleteConversation={deleteConversation}
            onCollapse={() => setSidebarOpen(false)}
            collapseLabel="Collapse sidebar"
          />
        </aside>
      ) : null}

      <section className="relative flex min-w-0 flex-1 flex-col bg-white">
          <Header
            onReset={resetChat}
            onShare={shareConversation}
            canShare={messages.length > 0}
            shareStatus={shareStatus}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((current) => !current)}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          />

          <div
            ref={scrollRef}
          className="scrollbar-soft flex-1 overflow-y-auto px-4 pb-44 pt-8 sm:px-6"
          >
            {messages.length === 0 ? (
              <EmptyState
                onPick={(prompt) => {
                  setInput(prompt);
                  inputRef.current?.focus();
                }}
              />
            ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-7">
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    copied={copiedMessageId === message.id}
                    onCopy={() => void copyMessage(message)}
                    onRetry={() => retryAssistantMessage(message.id)}
                  />
                ))}
                {isSending ? <LoadingBubble /> : null}
              </div>
            )}
          </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white to-white/0 px-4 pb-4 pt-12 sm:px-6">
          <div className="pointer-events-auto">
            {error && (
              <ErrorBanner
                message={error}
                canRetry={Boolean(lastUserMessage) || lastAssistantErrored}
                onRetry={retryLast}
              />
            )}
            <Composer
              value={input}
              images={pendingImages}
              pdfs={pendingPdfs}
              onChange={setInput}
              onSubmit={handleSubmit}
              onKeyDown={handleKeyDown}
              canSend={canSend}
              isSending={isSending}
              isReadingFiles={isReadingFiles}
              isListening={isListening}
              requestMode={requestMode}
              note={composerNote}
              onAttachClick={() => fileInputRef.current?.click()}
              onHostedImageClick={addHostedImageUrl}
              onRemoveImage={removePendingImage}
              onRemovePdf={removePendingPdf}
              onToggleVoice={toggleVoiceInput}
              onToggleRequestMode={() =>
                setRequestMode((current) =>
                  current === "extended" ? "standard" : "extended"
                )
              }
              inputRef={inputRef}
            />
            <input
              ref={fileInputRef}
              type="file"
              aria-label="Attach files"
              title="Attach files"
              className="hidden"
              multiple
              accept=".csv,.gif,.html,.jpeg,.jpg,.json,.log,.md,.pdf,.png,.ts,.tsx,.txt,.webp,.xml,text/*,application/json,application/pdf,application/xml,image/gif,image/jpeg,image/png,image/webp"
              onChange={(event) => void addAttachments(event.target.files)}
            />
          </div>
        </div>
      </section>

    </main>
  );
}

function SidebarPanel({
  conversations,
  activeConversationId,
  onNewChat,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
  onCollapse,
  collapseLabel
}: {
  conversations: Conversation[];
  activeConversationId: string;
  onNewChat: () => void;
  onOpenConversation: (conversation: Conversation) => void;
  onRenameConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onCollapse: () => void;
  collapseLabel: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="flex items-center justify-between gap-2">
        <BrandBlock />
        <button
          onClick={onCollapse}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[#555] transition hover:bg-[#ececec] hover:text-[#111] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9]"
          aria-label={collapseLabel}
          title={collapseLabel}
        >
          ◧
        </button>
      </div>

      <div className="mt-4 space-y-1">
        <SidebarButton label="New chat" icon="✎" onClick={onNewChat} />
      </div>

      <div className="mt-6 px-2 text-xs font-semibold text-[#6b6b6b]">
        Recents
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {conversations.length === 0 ? (
          <p className="px-3 py-2 text-sm text-[#8a8a8a]">No chats yet</p>
        ) : (
          <div className="space-y-1">
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`group flex items-center gap-1 rounded-lg ${
                  conversation.id === activeConversationId
                    ? "bg-[#ececec]"
                    : "hover:bg-[#ececec]"
                }`}
              >
                <button
                  onClick={() => onOpenConversation(conversation)}
                  className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm text-[#404040] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9]"
                  title={conversation.title}
                >
                  {conversation.title}
                </button>
                <button
                  onClick={() => onRenameConversation(conversation.id)}
                  className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#777] transition hover:bg-[#dedede] hover:text-[#111] group-hover:flex"
                  aria-label={`Rename ${conversation.title}`}
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  onClick={() => onDeleteConversation(conversation.id)}
                  className="mr-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#777] transition hover:bg-[#dedede] hover:text-[#111] group-hover:flex"
                  aria-label={`Delete ${conversation.title}`}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-auto border-t border-[#ececec] px-2 pt-3">
        <div className="flex items-center gap-2 rounded-lg px-2 py-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#0d0d0d] text-xs font-semibold text-white">
            A
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm text-[#333]">Apple Lamps</p>
            <p className="text-xs text-[#8a8a8a]">Pro</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function BrandBlock() {
  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-1">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">
            {exampleTitle}
          </h1>
        </div>
      </div>
    </div>
  );
}

function SidebarButton({
  label,
  icon,
  onClick
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-[#303030] transition hover:bg-[#ececec] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9]"
    >
      <span className="flex h-5 w-5 items-center justify-center text-sm text-[#555]">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function Header({
  onReset,
  onShare,
  canShare,
  shareStatus,
  sidebarOpen,
  onToggleSidebar,
  onOpenMobileSidebar
}: {
  onReset: () => void;
  onShare: () => void;
  canShare: boolean;
  shareStatus: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenMobileSidebar: () => void;
}) {
  return (
    <header className="flex h-14 items-center justify-between gap-3 bg-white px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onOpenMobileSidebar}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-[#444] transition hover:bg-[#f2f2f2] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] md:hidden"
          aria-label="Open sidebar"
          title="Open sidebar"
        >
          ◧
        </button>
        {!sidebarOpen ? (
          <button
            onClick={onToggleSidebar}
            className="hidden h-9 w-9 items-center justify-center rounded-lg text-[#444] transition hover:bg-[#f2f2f2] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] md:flex"
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            ◧
          </button>
        ) : null}
        <button
          onClick={onReset}
          className="rounded-lg px-3 py-2 text-sm font-medium text-[#444] transition hover:bg-[#f2f2f2] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] md:hidden"
        >
          New chat
        </button>
        <div className="hidden min-w-0 items-center gap-2 md:flex">
          <p className="truncate text-sm font-semibold text-[#333]">
            Candace
          </p>
          <span className="text-[#c7c7c7]">•</span>
          <p className="truncate font-mono text-xs text-[#777]">
            {visibleModelName}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onReset}
          className="hidden rounded-lg px-3 py-2 text-sm font-medium text-[#444] transition hover:bg-[#f2f2f2] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] sm:inline-flex"
        >
          New chat
        </button>
        <button
          onClick={onShare}
          disabled={!canShare}
          className="hidden rounded-lg px-3 py-2 text-sm font-medium text-[#444] transition hover:bg-[#f2f2f2] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] disabled:cursor-not-allowed disabled:text-[#b6b6b6] disabled:hover:bg-transparent sm:inline-flex"
          title={shareStatus || "Share conversation"}
        >
          {shareStatus || "Share"}
        </button>
      </div>
    </header>
  );
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex min-h-full max-w-4xl items-center justify-center">
      <div className="w-full py-10 text-center sm:py-16">
        <h2 className="text-2xl font-medium tracking-tight text-[#202123] sm:text-[28px]">
          Hi, how can I help?
        </h2>
        <div className="mx-auto mt-8 grid max-w-3xl gap-2 sm:grid-cols-2">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              onClick={() => onPick(prompt)}
              className="rounded-2xl border border-[#e5e5e5] bg-white p-4 text-left text-sm leading-6 text-[#5f6368] transition hover:bg-[#f7f7f8] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9]"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  copied,
  onCopy,
  onRetry
}: {
  message: Message;
  copied: boolean;
  onCopy: () => void;
  onRetry: () => void;
}) {
  const isUser = message.role === "user";
  const imageAttachments = message.imageAttachments || [];
  const pdfAttachments = message.pdfAttachments || [];
  const hasImageAttachments = imageAttachments.length > 0;
  const hasPdfAttachments = pdfAttachments.length > 0;

  return (
    <article
      className={`group flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div className={`${isUser ? "max-w-[78%]" : "w-full max-w-3xl"}`}>
        {isUser && (hasImageAttachments || hasPdfAttachments) ? (
          <div className="mb-2 flex flex-col items-end gap-2">
            {hasImageAttachments ? (
              <div className="grid max-w-[340px] grid-cols-1 gap-2">
                {imageAttachments.map((image) => (
                  <img
                    key={image.id}
                    src={image.url}
                    alt={image.name}
                    className="max-h-64 w-full rounded-[1.35rem] object-cover"
                  />
                ))}
              </div>
            ) : null}
            {hasPdfAttachments ? (
              <div className="flex max-w-[340px] flex-col gap-2">
                {pdfAttachments.map((pdf) => (
                  <a
                    key={pdf.id}
                    href={pdf.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-3 rounded-xl border border-[#e5e5e5] bg-white px-3 py-2.5 text-left text-sm text-[#111] shadow-sm transition hover:bg-[#f7f7f8]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#ff4f45] text-xs font-bold text-white">
                      PDF
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {pdf.name}
                      </span>
                      <span className="text-xs text-[#777]">PDF</span>
                    </span>
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={isUser ? "flex justify-end" : "flex justify-start"}>
          <div
            className={
              isUser
                ? "rounded-[1.35rem] bg-[#0d0d0d] px-4 py-3 text-white"
                : message.error
                  ? "rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-950"
                  : "px-1 py-1 text-[#111]"
            }
          >
            <MarkdownMessage content={message.content} isUser={isUser} />
            {!isUser && hasPdfAttachments ? (
              <div className="mt-3 flex flex-col gap-2">
                {pdfAttachments.map((pdf) => (
                  <a
                    key={pdf.id}
                    href={pdf.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-xs items-center gap-2 rounded-md bg-[#f2f2f2] px-2 py-1 text-xs text-[#555] underline-offset-4 hover:underline"
                  >
                    <span>▯</span>
                    <span className="truncate">{pdf.name}</span>
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div
          className={`mt-2 flex items-center gap-3 px-1 text-xs text-[#8a8a8a] ${
            isUser ? "justify-end" : "justify-start"
          }`}
        >
          <span>{roleLabel(message.role)}</span>
          <span>•</span>
          <time>{timeLabel(message.createdAt)}</time>
          {!isUser && !message.error ? (
            <span className="hidden items-center gap-2 opacity-0 transition group-hover:inline-flex group-hover:opacity-100 sm:inline-flex">
              <button
                type="button"
                onClick={onCopy}
                className="rounded px-1 py-0.5 hover:bg-[#f2f2f2] hover:text-[#444] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={onRetry}
                className="rounded px-1 py-0.5 hover:bg-[#f2f2f2] hover:text-[#444] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9]"
              >
                Retry
              </button>
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function MarkdownMessage({
  content,
  isUser
}: {
  content: string;
  isUser: boolean;
}) {
  return (
    <div
      className={`message-content text-[15px] leading-7 ${
        isUser ? "message-content-user" : "message-content-assistant"
      }`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function LoadingBubble() {
  return (
    <article className="flex justify-start">
      <div className="w-full max-w-3xl px-1 py-1">
        <div className="space-y-3">
          <div className="h-3 w-64 max-w-full animate-pulse rounded-full bg-[#ececec]" />
          <div className="h-3 w-48 max-w-full animate-pulse rounded-full bg-[#ececec]" />
          <p className="text-sm text-[#8a8a8a]">Thinking…</p>
        </div>
      </div>
    </article>
  );
}

function ErrorBanner({
  message,
  canRetry,
  onRetry
}: {
  message: string;
  canRetry: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto mb-3 flex max-w-4xl flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950 sm:flex-row sm:items-center sm:justify-between">
      <span>{message}</span>
      {canRetry ? (
        <button
          onClick={onRetry}
          className="rounded-full bg-red-950 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-800 focus:outline-none focus:ring-4 focus:ring-red-300"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function Composer({
  value,
  images,
  pdfs,
  onChange,
  onSubmit,
  onKeyDown,
  canSend,
  isSending,
  isReadingFiles,
  isListening,
  requestMode,
  note,
  onAttachClick,
  onHostedImageClick,
  onRemoveImage,
  onRemovePdf,
  onToggleVoice,
  onToggleRequestMode,
  inputRef
}: {
  value: string;
  images: ImageAttachment[];
  pdfs: PdfAttachment[];
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  isSending: boolean;
  isReadingFiles: boolean;
  isListening: boolean;
  requestMode: RequestMode;
  note: string | null;
  onAttachClick: () => void;
  onHostedImageClick: () => void;
  onRemoveImage: (id: string) => void;
  onRemovePdf: (id: string) => void;
  onToggleVoice: () => void;
  onToggleRequestMode: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl">
      <div className="rounded-[1.75rem] border border-[#d9d9d9] bg-white p-2 shadow-[0_8px_30px_rgba(0,0,0,0.10)] transition focus-within:border-[#bdbdbd]">
        {images.length > 0 || pdfs.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto px-2 pb-2 pt-1">
            {images.map((image) => (
              <div
                key={image.id}
                className="relative h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-[#d9d9d9] bg-[#f7f7f8]"
                title={image.name}
              >
                <img
                  src={image.url}
                  alt={image.name}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemoveImage(image.id)}
                  className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-sm text-white transition hover:bg-black"
                  aria-label={`Remove ${image.name}`}
                >
                  ×
                </button>
              </div>
            ))}
            {pdfs.map((pdf) => (
              <div
                key={pdf.id}
                className="relative flex h-16 w-72 max-w-[80vw] shrink-0 items-center gap-3 rounded-xl border border-[#d9d9d9] bg-[#f7f7f8] px-3 pr-9 text-sm text-[#222]"
                title={pdf.name}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#ff4f45] text-xs font-bold text-white">
                  PDF
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{pdf.name}</span>
                  <span className="text-xs text-[#777]">PDF</span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemovePdf(pdf.id)}
                  className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-sm text-white transition hover:bg-black"
                  aria-label={`Remove ${pdf.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything. Enter sends, Shift+Enter adds a line."
          rows={1}
          className="max-h-44 min-h-[46px] w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-6 text-[#0d0d0d] outline-none placeholder:text-[#9b9b9b]"
          disabled={isSending}
        />
        <div className="flex items-center justify-between px-2 pb-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onAttachClick}
              disabled={isSending || isReadingFiles}
              className="flex h-8 w-8 items-center justify-center rounded-full text-xl text-[#6f6f6f] transition hover:bg-[#f1f1f1] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9]"
              aria-label="Add attachment"
              title="Attach text, image, or PDF file"
            >
              {isReadingFiles ? "…" : "+"}
            </button>
            <button
              type="button"
              onClick={onHostedImageClick}
              disabled={isSending || isReadingFiles}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-[#6f6f6f] transition hover:bg-[#f1f1f1] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] disabled:cursor-not-allowed disabled:text-[#b6b6b6]"
              title="Attach hosted image or PDF URL"
            >
              URL
            </button>
            <button
              type="button"
              onClick={onToggleRequestMode}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] ${
                requestMode === "extended"
                  ? "bg-[#0d0d0d] text-white hover:bg-[#303030]"
                  : "text-[#6f6f6f] hover:bg-[#f1f1f1]"
              }`}
              title="Toggle longer answers"
            >
              Extended
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleVoice}
              className="hidden h-8 w-8 items-center justify-center rounded-full text-[#6f6f6f] transition hover:bg-[#f1f1f1] focus:outline-none focus:ring-2 focus:ring-[#d9d9d9] sm:flex"
              aria-label={isListening ? "Stop voice input" : "Start voice input"}
              title={isListening ? "Stop voice input" : "Start voice input"}
            >
              {isListening ? (
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
              ) : (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-[18px] w-[18px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                  <path d="M12 18v3" />
                  <path d="M8 21h8" />
                </svg>
              )}
            </button>
            <button
              type="submit"
              disabled={!canSend}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0d0d0d] text-white shadow-sm transition hover:bg-[#303030] focus:outline-none focus:ring-4 focus:ring-black/10 disabled:cursor-not-allowed disabled:bg-[#d9d9d9] disabled:text-white disabled:shadow-none"
              aria-label="Send message"
            >
              {isSending ? "…" : "↑"}
            </button>
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-[#8a8a8a]">
        {note || "AI can make mistakes. Check important info."}
      </p>
    </form>
  );
}

