# DocsAnthropic Reverse API Proxy for Deno

A Deno-compatible proxy server that forwards requests to the Inkeep API with enhanced authentication and token management.

## Features

- 🛡️ **Flexible Authentication**: Supports multiple tokens with fallback to defaults
- ⚡ **Edge Ready**: Designed for Deno Deploy's edge network
- 🔄 **Streaming Support**: Full compatibility with streaming responses
- 🔑 **Easy Token Setup**: Simple token configuration from browser DevTools

## Setup

1. **Get Your Inkeep Token**:
   - Visit [https://docs.anthropic.com/](https://docs.anthropic.com/)
   - Open Developer Tools (F12)
   - Start a chat conversation
   - In the Network tab, look for requests
   - Find and copy the `authorization: Bearer` token from the request headers

2. **Configuration**:
   - Set environment variable `DEFAULT_AUTH_TOKEN` with your token(s)
   - Multiple tokens can be separated by commas (e.g., `token1,token2,token3`)
   - Default tokens are `ej1,ej2` if no environment variable is set

## Deployment

### Deno Deploy

1. Create a new project on Deno Deploy
2. Set the `DEFAULT_AUTH_TOKEN` environment variable
3. Deploy the script

### Local Development

```bash
# Run with default tokens
deno run --allow-net --allow-env inkeep_proxy.ts

# Run with custom tokens
DEFAULT_AUTH_TOKEN="your_token1,your_token2" deno run --allow-net --allow-env inkeep_proxy.ts
```

## API Endpoints

### `POST /v1/chat/completions`

Chat completion endpoint that mirrors OpenAI's API format.

**Request Headers**:
- `Authorization: Bearer your_token` (optional)
  - Can be single token or comma-separated list
  - Special values `false`, `null`, or `none` will use default tokens
  - If omitted, uses default tokens

### `GET /v1/models`

Returns available model mappings.

### `GET /health`

Health check endpoint.

## Authentication Flow

1. If request has `Authorization` header:
   - Uses provided token(s)
   - Randomly selects one token per request if multiple provided
2. If no header or special value (`false`/`null`/`none`):
   - Uses default tokens from `DEFAULT_AUTH_TOKEN`
   - Randomly selects one token per request

## Notes

- The token from docs.anthropic.com appears to be non-user-specific and may be shared
- Token rotation is handled automatically by selecting randomly from available tokens
- All requests are forwarded to Inkeep's API with proper challenge solving

## Example Usage

```javascript
// Using fetch with custom token
const response = await fetch('https://your-proxy.deno.dev/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your_token_here' // or 'token1,token2,token3'
  },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Hello!' }],
    model: 'claude-3-7-sonnet-20250219'
  })
});

// Using default tokens (no Authorization header)
const response = await fetch('https://your-proxy.deno.dev/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Hello!' }],
    model: 'claude-3-7-sonnet-20250219',
    stream: true // for streaming
  })
});
```
