# FORGE

FORGE is a terminal coding agent built with TypeScript, Node.js, and pnpm. It supports Gemini and Groq and can inspect and safely modify files in a configured workspace.

Use Node.js 22 or later with pnpm.

## Set up a model provider

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey) and/or the [Groq Console](https://console.groq.com/keys).
2. Copy `.env.example` to `.env`.
3. Fill in the API key and model ID for the provider you plan to use.
4. Set `MODEL_PROVIDER` to `gemini` or `groq`.

Only the selected provider's key and model are required. `MODEL_PROVIDER` defaults to `gemini`. Keep `.env` private; Git ignores it.

| Variable | Description |
| --- | --- |
| `GEMINI_API_KEY` | Key from Google AI Studio |
| `GEMINI_MODEL` | Gemini model ID |
| `GROQ_API_KEY` | Key from the Groq Console |
| `GROQ_MODEL` | Groq model ID |
| `MODEL_PROVIDER` | `gemini` or `groq` |
| `FORGE_WORKSPACE` | Workspace directory; defaults to the current directory |

## Agent architecture

The provider interface gives the agent one way to send shared conversation messages, tool definitions, and a cancellation signal. Each provider adapter translates those into the selected SDK's format and converts streamed text and tool calls back into common events. Provider SDK types stay in their adapters.

The agent sends the current history and registered tools to the provider. It streams any response text, validates requested tool names and arguments, executes approved tools, adds their results to history, then asks the provider to continue. It stops when the model returns a normal answer, cancellation occurs, or a limit is reached: eight model iterations, twelve tool calls per task, and four calls in one model response.

Tools are registered with a name, description, Zod argument schema, and implementation. The registry supplies JSON Schema descriptions to the model. The tool executor independently validates every model request with Zod before running it.

The current workspace tools are:

- `list_files` lists workspace files.
- `read_file` reads a UTF-8 text file.
- `search_files` searches literal text in workspace files.
- `write_file` proposes creating a new file; it never overwrites an existing path.
- `edit_file` proposes one exact text replacement and rejects ambiguous matches.

Every create or edit displays a unified diff and requires explicit approval. Enter rejects; type `A` to approve or `R` to reject. Each change requires a separate decision. Ctrl+C cancels a pending approval. Rejected changes are returned to the model without modifying a file.

Workspace tools reject traversal and symbolic links, protect common secret files and generated directories, and apply file, scan, depth, and result limits. New files require an existing parent directory. Edits require one unique exact match. Changes are revalidated after approval and staged through same-directory temporary files before atomic publication where supported. FORGE never runs shell commands.

## Run FORGE

```sh
pnpm install
pnpm dev
```

Enter a task and press Enter. Use `/clear` to reset the conversation, `/exit` to quit, or Ctrl+C to cancel the current task and exit. Run `pnpm build` and then `pnpm start` to use the compiled build.

Automated tests use mocked provider responses and temporary workspaces; they do not contact Gemini or Groq.
