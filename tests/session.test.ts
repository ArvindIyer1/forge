import { describe, expect, it } from "vitest";
import { ConversationSession } from "../src/conversation/session.js";

describe("ConversationSession", () => {
  it("stores structured assistant and tool messages in history", () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "Find a file" });
    session.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "list_files", arguments: { path: "." } }],
    });
    session.append({
      role: "tool",
      toolCallId: "call-1",
      name: "list_files",
      content: "{\"ok\":true}",
    });

    expect(session.history.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(session.history[1]).toMatchObject({ toolCalls: [{ name: "list_files" }] });
  });

  it("can roll back a failed task and clear the conversation", () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "Earlier task" });
    const checkpoint = session.history.length;
    session.append({ role: "user", content: "Failed task" });

    session.truncate(checkpoint);
    expect(session.history).toEqual([{ role: "user", content: "Earlier task" }]);

    session.clear();
    expect(session.history).toEqual([]);
  });
});
