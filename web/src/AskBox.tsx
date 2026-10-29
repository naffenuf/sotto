/**
 * "Ask Sotto…" — a question typed instead of said (US-019).
 *
 * It sits under the stage because that is where the answer lands, and it is
 * the same question by another route: the server hands it to the same answer
 * agent a wake phrase would (US-018), so what comes back is an ordinary
 * answer card arriving on `/ws/events`. Nothing is rendered here but the box.
 *
 * The box stays usable after Stop. A group reads the board once the talking
 * has finished, and the question somebody meant to ask out loud is usually
 * the one they type then — so the server answers it against the last
 * conversation rather than refusing.
 */
import { useState, type FormEvent } from "react";

export interface AskBoxProps {
  /**
   * Sends the question. Resolving clears the box; rejecting leaves what was
   * typed where it is, because a question nobody can see any more is a
   * question that has to be typed twice.
   */
  onAsk: (question: string) => Promise<unknown>;
}

export function AskBox({ onAsk }: AskBoxProps) {
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const asked = question.trim();
    if (asked === "" || sending) return;
    setSending(true);
    void onAsk(asked)
      .then(() => setQuestion(""))
      .catch(() => {})
      .finally(() => setSending(false));
  };

  return (
    <form className="ask" data-testid="ask" onSubmit={submit}>
      <div className="ask__row">
        <input
          className="ask__input"
          data-testid="ask-input"
          type="text"
          // The form submits on Enter on its own; the button is for the mouse.
          placeholder="Ask Sotto…"
          aria-label="Ask Sotto a question"
          value={question}
          disabled={sending}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          className="ask__send"
          data-testid="ask-send"
          type="submit"
          disabled={sending || question.trim() === ""}
        >
          Ask
        </button>
      </div>
    </form>
  );
}
