import { useEffect, useRef, useState, type FormEvent } from "react";

import { BasicShell } from "~/layouts/app-shell/app-shell";
import { ModuleLayout } from "~/layouts/module/module-layout";

import classes from "./chat.route.module.css";

export const meta = () => [{ title: "Chat demo" }];

export default function Chat() {
  const [messages, setMessages] = useState([
    {
      id: 0,
      author: "Mira",
      text: "I’m putting together the agenda for our design review. What would you like to cover?",
    },
  ]);
  const [draft, setDraft] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (messages.length > 1 && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages.length]);

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages((previous) => [
      ...previous,
      { id: previous.length, author: "You", text },
      { id: previous.length + 1, author: "Mira", text: "Thanks, I’ve noted that for the review." },
    ]);
    setDraft("");
    input.current?.focus();
  }

  return (
    <BasicShell title="Chat demo">
      <ModuleLayout moduleId="chat" contentAs="main" title="Chat demo">
        <div className={classes.chat}>
          <h1 id="chat-title">Design review</h1>
          <div role="log" aria-labelledby="chat-title" ref={thread} className={classes.thread}>
            {messages.map((message) => (
              <div key={message.id} className={message.author === "You" ? classes.outgoing : classes.incoming}>
                <strong>{message.author}</strong>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          <form onSubmit={send} className={classes.composer}>
            <label htmlFor="chat-message">Message</label>
            <div>
              <input
                id="chat-message"
                autoComplete="off"
                ref={input}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" disabled={!draft.trim()}>
                Send
              </button>
            </div>
          </form>
        </div>
      </ModuleLayout>
    </BasicShell>
  );
}
