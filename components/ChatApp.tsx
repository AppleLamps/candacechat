"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, SUGGESTED_PROMPTS } from "@/lib/defaults";

type Role = "user" | "assistant";

type Message = {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  error?: boolean;
};

type ApiError = {
  error: string;
  status?: number;
};

const exampleTitle = "Candace Voice Chat";

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

export default function ChatApp() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [draftModel, setDraftModel] = useState(DEFAULT_MODEL);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const canSend = input.trim().length > 0 && !isSending;
  const lastAssistantErrored = messages[messages.length - 1]?.error === true;

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages, isSending]);

  useEffect(() => {
    if (settingsOpen) {
      setDraftPrompt(systemPrompt);
      setDraftModel(model);
    }
  }, [settingsOpen, systemPrompt, model]);

  const requestMessages = useMemo(
    () =>
      messages
        .filter((message) => !message.error)
        .map((message) => ({
          role: message.role,
          content: message.content
        })),
    [messages]
  );

  async function sendMessage(content: string, retry = false) {
    const trimmed = content.trim();
    if (!trimmed || isSending) return;

    setError(null);
    setIsSending(true);
    setLastUserMessage(trimmed);

    const userMessage: Message = {
      id: uid(),
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString()
    };

    const nextMessages = retry ? requestMessages : [...requestMessages, userMessage];

    if (!retry) {
      setMessages((current) => [...current, userMessage]);
      setInput("");
    } else {
      setMessages((current) => current.filter((message) => !message.error));
    }

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          systemPrompt,
          messages: nextMessages
        })
      });

      const data = (await response.json().catch(() => ({}))) as
        | { reply?: string }
        | ApiError;

      if (!response.ok || "error" in data) {
        const message =
          "error" in data
            ? data.error
            : "The request failed. Please try again.";
        throw new Error(message);
      }

      setMessages((current) => [
        ...current,
        {
          id: uid(),
          role: "assistant",
          content: data.reply || "No response returned.",
          createdAt: new Date().toISOString()
        }
      ]);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Something went wrong.";
      setError(message);
      setMessages((current) => [
        ...current,
        {
          id: uid(),
          role: "assistant",
          content: message,
          createdAt: new Date().toISOString(),
          error: true
        }
      ]);
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

  function saveSettings() {
    setSystemPrompt(draftPrompt.trim() || DEFAULT_SYSTEM_PROMPT);
    setModel(draftModel.trim() || DEFAULT_MODEL);
    setSettingsOpen(false);
  }

  function resetChat() {
    setMessages([]);
    setInput("");
    setError(null);
    setLastUserMessage(null);
    inputRef.current?.focus();
  }

  return (
    <main className="min-h-screen px-3 py-3 text-ink sm:px-4 lg:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-7xl overflow-hidden rounded-[2rem] border border-white/75 bg-white/70 shadow-soft backdrop-blur-xl">
        <aside className="hidden w-[320px] shrink-0 border-r border-line/80 bg-[#f8f4ec]/85 p-5 lg:flex lg:flex-col">
          <BrandBlock />
          <div className="mt-8 space-y-3">
            <SidebarButton
              label="New conversation"
              icon="+"
              onClick={resetChat}
            />
            <SidebarButton
              label="Assistant settings"
              icon="⌘"
              onClick={() => setSettingsOpen(true)}
            />
          </div>
          <div className="mt-8 rounded-3xl border border-line bg-white/70 p-4 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-ink/45">
              Active model
            </p>
            <p className="mt-2 break-all font-mono text-sm text-ink">{model}</p>
          </div>
          <div className="mt-auto rounded-3xl border border-line bg-white/55 p-4">
            <p className="font-display text-2xl leading-tight">
              Prompt control, without clutter.
            </p>
            <p className="mt-3 text-sm leading-6 text-ink/62">
              Edit the system prompt in settings. Every request sends the full
              chat history with your current behavior prompt first.
            </p>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <Header
            model={model}
            onOpenSettings={() => setSettingsOpen(true)}
            onReset={resetChat}
          />

          <div
            ref={scrollRef}
            className="scrollbar-soft flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10"
          >
            {messages.length === 0 ? (
              <EmptyState
                onPick={(prompt) => {
                  setInput(prompt);
                  inputRef.current?.focus();
                }}
              />
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-5">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                {isSending ? <LoadingBubble /> : null}
              </div>
            )}
          </div>

          <div className="border-t border-line/80 bg-white/65 px-4 py-4 backdrop-blur sm:px-6 lg:px-10">
            {error && (
              <ErrorBanner
                message={error}
                canRetry={Boolean(lastUserMessage) || lastAssistantErrored}
                onRetry={retryLast}
              />
            )}
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onKeyDown={handleKeyDown}
              canSend={canSend}
              isSending={isSending}
              inputRef={inputRef}
            />
          </div>
        </section>
      </div>

      <SettingsPanel
        open={settingsOpen}
        draftPrompt={draftPrompt}
        draftModel={draftModel}
        onPromptChange={setDraftPrompt}
        onModelChange={setDraftModel}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
        onReset={() => {
          setDraftPrompt(DEFAULT_SYSTEM_PROMPT);
          setDraftModel(DEFAULT_MODEL);
        }}
      />
    </main>
  );
}

function BrandBlock() {
  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-ink text-lg font-black text-white shadow-float">
          C
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {exampleTitle}
          </h1>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">
            OpenRouter powered
          </p>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-ink/60">
        A refined chat interface with editable behavior and secure server-side
        OpenRouter calls.
      </p>
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
      className="group flex w-full items-center justify-between rounded-2xl border border-line bg-white/72 px-4 py-3 text-left text-sm font-bold text-ink shadow-sm transition hover:-translate-y-0.5 hover:border-brand/30 hover:bg-white focus:outline-none focus:ring-4 focus:ring-brand/15"
    >
      <span className="font-semibold">{label}</span>
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-warm text-xs text-ink/70 transition group-hover:bg-brand group-hover:text-white">
        {icon}
      </span>
    </button>
  );
}

function Header({
  model,
  onOpenSettings,
  onReset
}: {
  model: string;
  onOpenSettings: () => void;
  onReset: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-line/80 bg-white/72 px-4 py-4 backdrop-blur sm:px-6 lg:px-8">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.14)]" />
          <p className="truncate text-xs font-bold uppercase tracking-[0.2em] text-ink/45">
            Ready
          </p>
        </div>
        <h2 className="mt-1 truncate font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          Candace-style assistant
        </h2>
        <p className="mt-1 truncate font-mono text-xs text-ink/45">{model}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onReset}
          className="hidden rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink/70 transition hover:-translate-y-0.5 hover:text-ink focus:outline-none focus:ring-4 focus:ring-brand/15 sm:inline-flex"
        >
          New chat
        </button>
        <button
          onClick={onOpenSettings}
          className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-white shadow-float transition hover:-translate-y-0.5 hover:bg-brand-ink focus:outline-none focus:ring-4 focus:ring-brand/20"
        >
          Settings
        </button>
      </div>
    </header>
  );
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex min-h-full max-w-5xl items-center">
      <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.24em] text-brand">
            Start a conversation
          </p>
          <h2 className="mt-4 max-w-2xl font-display text-5xl font-semibold leading-[0.96] tracking-tight sm:text-6xl">
            A polished chat surface for sharp, configurable voice.
          </h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-ink/64">
            Your system prompt lives in settings, the model defaults to Gemini
            Flash Latest through OpenRouter, and every turn keeps the session
            context intact.
          </p>
        </div>
        <div className="rounded-[2rem] border border-line bg-white/78 p-4 shadow-soft">
          <p className="px-2 pb-3 text-sm font-bold text-ink/60">
            Try one of these
          </p>
          <div className="grid gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => onPick(prompt)}
                className="rounded-2xl border border-line bg-[#fbfaf7] p-4 text-left text-sm leading-6 text-ink/78 transition hover:-translate-y-0.5 hover:border-brand/35 hover:bg-white hover:shadow-sm focus:outline-none focus:ring-4 focus:ring-brand/15"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <article
      className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
    >
      {!isUser && <Avatar label="A" />}
      <div className={`max-w-[88%] sm:max-w-[76%] ${isUser ? "order-first" : ""}`}>
        <div
          className={`rounded-[1.4rem] px-5 py-4 shadow-sm ${
            isUser
              ? "rounded-tr-md bg-ink text-white"
              : message.error
                ? "rounded-tl-md border border-red-200 bg-red-50 text-red-950"
                : "rounded-tl-md border border-line bg-white text-ink"
          }`}
        >
          <div className="message-content whitespace-pre-wrap text-sm leading-6 sm:text-[15px]">
            {message.content}
          </div>
        </div>
        <div
          className={`mt-2 flex items-center gap-2 text-xs text-ink/42 ${
            isUser ? "justify-end" : "justify-start"
          }`}
        >
          <span>{roleLabel(message.role)}</span>
          <span>•</span>
          <time>{timeLabel(message.createdAt)}</time>
        </div>
      </div>
      {isUser && <Avatar label="Y" />}
    </article>
  );
}

function Avatar({ label }: { label: string }) {
  return (
    <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-line bg-white font-bold text-ink shadow-sm">
      {label}
    </div>
  );
}

function LoadingBubble() {
  return (
    <article className="flex gap-3">
      <Avatar label="A" />
      <div className="max-w-[76%] rounded-[1.4rem] rounded-tl-md border border-line bg-white px-5 py-4 shadow-sm">
        <div className="space-y-3">
          <div className="h-3 w-64 max-w-full animate-pulse rounded-full bg-warm" />
          <div className="h-3 w-48 max-w-full animate-pulse rounded-full bg-warm" />
          <div className="flex gap-1 pt-1">
            <span className="h-2 w-2 animate-bounce rounded-full bg-brand/70 [animation-delay:-0.2s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-brand/70 [animation-delay:-0.1s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-brand/70" />
          </div>
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
  onChange,
  onSubmit,
  onKeyDown,
  canSend,
  isSending,
  inputRef
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  isSending: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-4xl">
      <div className="rounded-[1.7rem] border border-line bg-white p-2 shadow-float transition focus-within:border-brand/35 focus-within:ring-4 focus-within:ring-brand/10">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything. Enter sends, Shift+Enter adds a line."
          rows={1}
          className="max-h-44 min-h-[58px] w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-6 text-ink outline-none placeholder:text-ink/38"
          disabled={isSending}
        />
        <div className="flex items-center justify-between border-t border-line/80 px-2 pt-2">
          <p className="hidden text-xs text-ink/42 sm:block">
            Press <kbd className="rounded-md border border-line px-1.5 py-0.5">Enter</kbd> to send · <kbd className="rounded-md border border-line px-1.5 py-0.5">Shift</kbd> + <kbd className="rounded-md border border-line px-1.5 py-0.5">Enter</kbd> for newline
          </p>
          <button
            type="submit"
            disabled={!canSend}
            className="ml-auto rounded-full bg-brand px-5 py-2.5 text-sm font-extrabold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-brand-ink focus:outline-none focus:ring-4 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-ink/18 disabled:text-ink/35 disabled:shadow-none disabled:hover:translate-y-0"
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </form>
  );
}

function SettingsPanel({
  open,
  draftPrompt,
  draftModel,
  onPromptChange,
  onModelChange,
  onClose,
  onSave,
  onReset
}: {
  open: boolean;
  draftPrompt: string;
  draftModel: string;
  onPromptChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        aria-label="Close settings"
        className="absolute inset-0 bg-ink/24 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-2xl flex-col border-l border-line bg-[#fffdf8] shadow-[0_30px_100px_rgba(22,24,29,0.22)] sm:rounded-l-[2rem]">
        <div className="border-b border-line px-5 py-5 sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[0.22em] text-brand">
                Settings
              </p>
              <h2 className="mt-2 font-display text-4xl font-semibold tracking-tight">
                Tune the assistant.
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ink/58">
                The system prompt is sent first on every request, followed by
                the conversation history.
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-full border border-line bg-white px-3 py-2 text-sm font-bold text-ink/60 transition hover:text-ink focus:outline-none focus:ring-4 focus:ring-brand/15"
            >
              Close
            </button>
          </div>
        </div>

        <div className="scrollbar-soft flex-1 space-y-6 overflow-y-auto px-5 py-6 sm:px-7">
          <label className="block">
            <span className="text-sm font-bold text-ink">Model</span>
            <input
              value={draftModel}
              onChange={(event) => onModelChange(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 font-mono text-sm text-ink outline-none transition focus:border-brand/40 focus:ring-4 focus:ring-brand/10"
            />
          </label>

          <label className="block">
            <span className="text-sm font-bold text-ink">System prompt</span>
            <textarea
              value={draftPrompt}
              onChange={(event) => onPromptChange(event.target.value)}
              className="scrollbar-soft mt-2 min-h-[430px] w-full resize-none rounded-2xl border border-line bg-white px-4 py-4 text-sm leading-6 text-ink outline-none transition focus:border-brand/40 focus:ring-4 focus:ring-brand/10"
            />
          </label>
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-line bg-white/70 px-5 py-4 sm:flex-row sm:justify-between sm:px-7">
          <button
            onClick={onReset}
            className="rounded-full border border-line bg-white px-5 py-3 text-sm font-bold text-ink/72 transition hover:-translate-y-0.5 hover:text-ink focus:outline-none focus:ring-4 focus:ring-brand/15"
          >
            Reset defaults
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-full border border-line bg-white px-5 py-3 text-sm font-bold text-ink/72 transition hover:-translate-y-0.5 hover:text-ink focus:outline-none focus:ring-4 focus:ring-brand/15 sm:flex-none"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              className="flex-1 rounded-full bg-ink px-5 py-3 text-sm font-extrabold text-white shadow-float transition hover:-translate-y-0.5 hover:bg-brand-ink focus:outline-none focus:ring-4 focus:ring-brand/20 sm:flex-none"
            >
              Save settings
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
