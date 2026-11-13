# FORGE

FORGE is a terminal chatbot powered by Google's Gemini API.

Use Node.js 22 or later with pnpm.

## Set up Gemini

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Copy `.env.example` to `.env`.
3. Put your key in `GEMINI_API_KEY` and choose a model in `GEMINI_MODEL`. The example uses `gemini-3.8-flash`.

Keep `.env` private. It is ignored by Git.

## Run FORGE

Install the project dependencies with `pnpm install`, then start the chat:

```sh
pnpm dev
```

Type a message and press Enter. Responses stream into the terminal. Use `/clear` to start a fresh conversation or `/exit` to quit. Press Ctrl+C to quit as well.

To create the compiled JavaScript build, run `pnpm build`; to launch that build, run `pnpm start`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes | API key from Google AI Studio |
| `GEMINI_MODEL` | Yes | Gemini model ID to use |

If your key, model, or account has an issue, FORGE prints a short diagnostic. Automated tests use a fake chat provider and do not contact Gemini.
