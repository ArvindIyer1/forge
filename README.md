# FORGE

FORGE is a terminal chatbot that can use Gemini or Groq. Use Node.js 22 or later with pnpm.

## Provider abstraction

A provider abstraction gives the conversation code one shared interface for different model services. The `ModelProvider` interface reports the selected provider and model, accepts common `system`, `user`, and `assistant` messages, streams text, and formats provider errors. The conversation session owns message history and passes it to the provider for each response.

Each adapter translates that shared interface into its provider's SDK format. The Gemini adapter maps assistant messages to Gemini's `model` role and system messages to its system instruction. The Groq adapter sends the shared roles as Groq chat messages. SDK-specific request and response types stay inside the adapters, so neither the CLI nor conversation session needs to know which SDK is active.

To add another provider later, add its API key and model to configuration, implement `ModelProvider` in a new adapter, and register it in the provider factory. The terminal and conversation code can stay unchanged.

## Configure Gemini and Groq

1. Create a Gemini key in [Google AI Studio](https://aistudio.google.com/apikey) and/or a Groq key in the [Groq Console](https://console.groq.com/keys).
2. Copy `.env.example` to `.env`.
3. Replace the key placeholders and model ID placeholders for the provider you want to use.
4. Set `MODEL_PROVIDER` to `gemini` or `groq`.

Only the selected provider's key and model are required. `MODEL_PROVIDER` defaults to `gemini` if it is omitted. Keep `.env` private; Git ignores it.

| Variable | Used when | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | `MODEL_PROVIDER=gemini` | Key from Google AI Studio |
| `GEMINI_MODEL` | `MODEL_PROVIDER=gemini` | Gemini model ID |
| `GROQ_API_KEY` | `MODEL_PROVIDER=groq` | Key from the Groq Console |
| `GROQ_MODEL` | `MODEL_PROVIDER=groq` | Groq model ID |
| `MODEL_PROVIDER` | Always | `gemini` or `groq` |

## Run FORGE

Install dependencies and start the chat:

```sh
pnpm install
pnpm dev
```

Enter messages and press Enter. Responses stream into the terminal. Use `/clear` to start a fresh conversation, `/exit` to quit, or Ctrl+C to stop. To build and run the compiled version, use `pnpm build` followed by `pnpm start`.

Automated tests use mocked provider responses and do not contact either API.
