// Import required Deno modules
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.192.0/crypto/mod.ts";

// Inkeep API configuration
const INKEEP_CONFIG = {
  CHALLENGE_URL: 'https://api.inkeep.com/v1/challenge',
  CHAT_URL: 'https://api.inkeep.com/v1/chat/completions',
  DEFAULT_REFERER: 'https://docs.anthropic.com/',
  DEFAULT_ORIGIN: 'https://docs.anthropic.com'
};

// Default tokens (can be overridden by environment variables)
const DEFAULT_TOKENS = ["ej1", "ej2"];
const DEFAULT_AUTH_TOKENS = Deno.env.get("DEFAULT_AUTH_TOKEN")?.split(",") || DEFAULT_TOKENS;

// Model mapping configuration
const MODEL_MAPPING: Record<string, string> = {
  'claude-3-7-sonnet-20250219': 'inkeep-context-expert'
};

// Helper function to parse request body
async function parseRequestBody(req: Request): Promise<any> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await req.json();
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await req.formData();
    const result: Record<string, any> = {};
    for (const [key, value] of formData.entries()) {
      result[key] = value;
    }
    return result;
  }
  return {};
}

// Challenge solver class
class InkeepChallenge {
  /**
   * Calculate hash using specified algorithm and data
   */
  static async calculateHash(algorithm: string, data: string): Promise<string> {
    const hashAlgorithm = algorithm.toLowerCase().replace('-', '');
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    
    let hashBuffer: ArrayBuffer;
    switch (hashAlgorithm) {
      case 'sha256':
        hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
        break;
      case 'sha384':
        hashBuffer = await crypto.subtle.digest('SHA-384', dataBuffer);
        break;
      case 'sha512':
        hashBuffer = await crypto.subtle.digest('SHA-512', dataBuffer);
        break;
      default:
        throw new Error(`Unsupported hash algorithm: ${hashAlgorithm}`);
    }
    
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Solve Inkeep's proof-of-work challenge
   */
  static async solveChallenge(): Promise<string | null> {
    try {
      console.log(`[${new Date().toISOString()}] Fetching Inkeep challenge...`);
      
      const response = await fetch(INKEEP_CONFIG.CHALLENGE_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          'origin': INKEEP_CONFIG.DEFAULT_ORIGIN,
          'referer': INKEEP_CONFIG.DEFAULT_REFERER,
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to get challenge: ${response.status} ${response.statusText}`);
      }

      const challengeData = await response.json();
      const { algorithm, challenge, maxnumber, salt } = challengeData;

      console.log(`[${new Date().toISOString()}] Challenge received, calculating solution...`);
      const startTime = Date.now();

      let solutionNumber = -1;
      for (let number = 0; number <= maxnumber; number++) {
        const dataToHash = salt + number;
        const hash = await this.calculateHash(algorithm, dataToHash);
        if (hash === challenge) {
          solutionNumber = number;
          break;
        }
      }
      
      const endTime = Date.now();

      if (solutionNumber === -1) {
        throw new Error('Failed to solve challenge, no valid number found.');
      }

      console.log(`[${new Date().toISOString()}] Challenge solved! Number: ${solutionNumber}, time taken: ${endTime - startTime}ms`);

      const payload = { number: solutionNumber, ...challengeData };
      const jsonString = JSON.stringify(payload);
      return btoa(jsonString);

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error solving challenge:`, error);
      return null;
    }
  }
}

// Message utilities class
class MessageUtils {
  /**
   * Normalize message content to array format
   */
  static normalizeContent(content: string | any[]): any[] {
    if (typeof content === 'string') {
      return [{ type: "text", text: content }];
    }
    return content;
  }

  /**
   * Merge two content arrays
   */
  static mergeContents(content1: any[], content2: any[]): any[] {
    if (content1.length === 1 && content1[0].type === 'text') {
      if (content2.length === 1 && content2[0].type === 'text') {
        return [{
          type: "text",
          text: content1[0].text + '\n' + content2[0].text
        }];
      } else {
        return [...content1, ...content2];
      }
    } else {
      return [...content1, ...content2];
    }
  }

  /**
   * Merge consecutive messages with same role
   */
  static mergeMessages(messages: any[]): any[] {
    if (!messages || messages.length === 0) return [];
    
    const merged = [];
    let current = { ...messages[0] };
    
    if (current.role === 'system') {
      current.role = 'user';
    }
    
    current.content = this.normalizeContent(current.content);
    
    for (let i = 1; i < messages.length; i++) {
      let message = { ...messages[i] };
      
      if (message.role === 'system') {
        message.role = 'user';
      }
      
      message.content = this.normalizeContent(message.content);
      
      if (current.role === message.role) {
        current.content = this.mergeContents(current.content, message.content);
      } else {
        merged.push(current);
        current = message;
      }
    }
    
    merged.push(current);
    return merged;
  }
  
  /**
   * Convert OpenAI format to Inkeep format
   */
  static convertToInkeepFormat(messages: any[], params: any = {}): any {
    return {
      model: params.model || 'inkeep-context-expert',
      messages: messages,
      temperature: params.temperature || 0.7,
      top_p: params.top_p || 1,
      max_tokens: params.max_tokens || 2048,
      frequency_penalty: params.frequency_penalty || 0,
      presence_penalty: params.presence_penalty || 0,
      stream: params.stream || false
    };
  }
  
  /**
   * Convert Inkeep response to OpenAI format
   */
  static convertFromInkeepFormat(inkeepResponse: any, model: string): any {
    return {
      id: 'chatcmpl-' + Math.random().toString(36).substring(2, 11),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: inkeepResponse.choices[0].message.content || 'No response'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: inkeepResponse.usage?.prompt_tokens || 0,
        completion_tokens: inkeepResponse.usage?.completion_tokens || 0,
        total_tokens: inkeepResponse.usage?.total_tokens || 0
      }
    };
  }
}

// Response handler class
class ResponseHandler {
  /**
   * Handle stream response
   */
  static async handleStreamResponse(res: any, inkeepResponse: Response, model: string) {
    const headers = new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*'
    });

    const stream = new ReadableStream({
      async start(controller) {
        const responseId = 'chatcmpl-' + Math.random().toString(36).substring(2, 11);
        const timestamp = Math.floor(Date.now() / 1000);
        
        if (!inkeepResponse.body) {
          controller.close();
          return;
        }

        const reader = inkeepResponse.body.getReader();
        let buffer = '';
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += new TextDecoder().decode(value);
            let lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim().startsWith('data: ')) {
                const dataContent = line.trim().substring(6);
                
                if (dataContent === '[DONE]') {
                  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                  continue;
                }

                try {
                  const jsonData = JSON.parse(dataContent);
                  const content = jsonData.choices[0]?.delta?.content;
                  
                  if (content) {
                    const chunk = {
                      id: responseId,
                      object: 'chat.completion.chunk',
                      created: timestamp,
                      model: model,
                      choices: [{
                        index: 0,
                        delta: { content: content },
                        finish_reason: null
                      }]
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  } else if (jsonData.choices[0]?.finish_reason) {
                    const endChunk = {
                      id: responseId,
                      object: 'chat.completion.chunk',
                      created: timestamp,
                      model: model,
                      choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: jsonData.choices[0].finish_reason
                      }]
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                  }
                } catch (e) {
                  // Ignore JSON parsing errors
                }
              }
            }
          }
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          console.error('Stream error:', error);
          const errorChunk = {
            error: {
              message: error.message,
              type: 'server_error'
            }
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
          controller.close();
        }
      }
    });

    return new Response(stream, { headers });
  }
  
  /**
   * Handle non-stream response
   */
  static async handleNonStreamResponse(inkeepResponse: Response, model: string) {
    try {
      const responseData = await inkeepResponse.json();
      const openaiResponse = MessageUtils.convertFromInkeepFormat(responseData, model);
      return Response.json(openaiResponse);
    } catch (error) {
      console.error('Non-stream response error:', error);
      return Response.json({
        error: {
          message: 'Internal server error',
          type: 'server_error',
          code: 'internal_error'
        }
      }, { status: 500 });
    }
  }
  
  /**
   * Call Inkeep API
   */
  static async callInkeepApi(requestData: any, authToken: string) {
    try {
      const challengeSolution = await InkeepChallenge.solveChallenge();
      if (!challengeSolution) {
        throw new Error('Failed to get challenge solution');
      }

      const headers: Record<string, string> = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Accept': 'application/json', 
        'Content-Type': 'application/json',
        'accept-language': 'zh-CN,zh;q=0.9',
        'authorization': `Bearer ${authToken}`, 
        'cache-control': 'no-cache',
        'origin': INKEEP_CONFIG.DEFAULT_ORIGIN,
        'pragma': 'no-cache',
        'referer': INKEEP_CONFIG.DEFAULT_REFERER,
        'x-inkeep-challenge-solution': challengeSolution,
      };

      const response = await fetch(INKEEP_CONFIG.CHAT_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Inkeep API error: ${response.status} ${response.statusText} ${errorText}`);
      }

      return response;
    } catch (error) {
      throw new Error(`Inkeep API error: ${error.message}`);
    }
  }
}

// Token authentication middleware
function authenticateRequest(req: Request): { valid: boolean; tokens: string[] } {
  const authHeader = req.headers.get('authorization');
  
  // If no auth header, use default tokens
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: true, tokens: DEFAULT_AUTH_TOKENS };
  }
  
  const tokenString = authHeader.substring(7).trim();
  
  // Check for special values that mean "use default tokens"
  if (['false', 'null', 'none', ''].includes(tokenString.toLowerCase())) {
    return { valid: true, tokens: DEFAULT_AUTH_TOKENS };
  }
  
  // Split tokens by comma and filter out empty strings
  const tokens = tokenString.split(',').map(t => t.trim()).filter(t => t);
  
  if (tokens.length === 0) {
    return { valid: false, tokens: [] };
  }
  
  return { valid: true, tokens };
}

// Main request handler
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }
  
  // Health check endpoint
  if (url.pathname === '/health' && req.method === 'GET') {
    return Response.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      models: Object.keys(MODEL_MAPPING).length,
      service: 'Inkeep API Proxy'
    });
  }
  
  // Models list endpoint
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    // First authenticate
    const authResult = authenticateRequest(req);
    if (!authResult.valid) {
      return Response.json({ 
        error: { 
          message: 'Invalid authorization token provided',
          type: 'invalid_request_error',
          code: 'invalid_token'
        }
      }, { status: 401 });
    }
    
    const models = Object.keys(MODEL_MAPPING).map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'inkeep',
      permission: [
        {
          id: 'modelperm-' + Math.random().toString(36).substring(2, 11),
          object: 'model_permission',
          created: Math.floor(Date.now() / 1000),
          allow_create_engine: false,
          allow_sampling: true,
          allow_logprobs: true,
          allow_search_indices: false,
          allow_view: true,
          allow_fine_tuning: false,
          organization: '*',
          group: null,
          is_blocking: false
        }
      ],
      root: modelId,
      parent: null
    }));
    
    return Response.json({
      object: 'list',
      data: models
    });
  }
  
  // Chat completions endpoint
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    // First authenticate
    const authResult = authenticateRequest(req);
    if (!authResult.valid) {
      return Response.json({ 
        error: { 
          message: 'Invalid authorization token provided',
          type: 'invalid_request_error',
          code: 'invalid_token'
        }
      }, { status: 401 });
    }
    
    try {
      const requestData = await parseRequestBody(req);
      const {
        messages,
        model = 'claude-3-7-sonnet-20250219',
        stream = false,
        temperature,
        top_p: topP,
        max_tokens,
        frequency_penalty,
        presence_penalty,
        ...otherParams
      } = requestData;
      
      // Validate required parameters
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return Response.json({ 
          error: {
            message: 'Messages array is required and cannot be empty',
            type: 'invalid_request_error',
            code: 'invalid_parameter'
          }
        }, { status: 400 });
      }
      
      console.log(`[${new Date().toISOString()}] Chat completion request: model=${model}, stream=${stream}, messages=${messages.length}`);
      
      // Merge consecutive messages with same role
      const mergedMessages = MessageUtils.mergeMessages(messages);
      
      // Map model name
      const inkeepModel = MODEL_MAPPING[model] || 'inkeep-context-expert';
      
      // Build request parameters
      const requestParams: Record<string, any> = {
        model: inkeepModel,
        stream: stream,
        ...otherParams
      };
      
      if (temperature !== undefined) requestParams.temperature = temperature;
      if (topP !== undefined) requestParams.top_p = topP;
      if (max_tokens !== undefined) requestParams.max_tokens = max_tokens;
      if (frequency_penalty !== undefined) requestParams.frequency_penalty = frequency_penalty;
      if (presence_penalty !== undefined) requestParams.presence_penalty = presence_penalty;
      
      // Convert to Inkeep API format
      const inkeepRequest = MessageUtils.convertToInkeepFormat(mergedMessages, requestParams);
      
      console.log(`[${new Date().toISOString()}] Inkeep request prepared for model: ${inkeepModel}`);
      
      // Select a random token from available tokens
      const randomToken = authResult.tokens[Math.floor(Math.random() * authResult.tokens.length)];
      
      // Call Inkeep API
      const inkeepResponse = await ResponseHandler.callInkeepApi(inkeepRequest, randomToken);
      
      // Handle response based on stream parameter
      if (stream) {
        return await ResponseHandler.handleStreamResponse(inkeepResponse, model);
      } else {
        return await ResponseHandler.handleNonStreamResponse(inkeepResponse, model);
      }
      
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error in chat completions:`, error);
      return Response.json({ 
        error: {
          message: 'Internal server error',
          type: 'server_error',
          code: 'internal_error'
        }
      }, { status: 500 });
    }
  }
  
  // 404 for unknown routes
  return Response.json({ 
    error: {
      message: `Unknown request URL: ${req.method} ${url.pathname}`,
      type: 'invalid_request_error',
      code: 'not_found'
    }
  }, { status: 404 });
}

// Start the server
console.log("Inkeep API Proxy Server is running");
serve(handleRequest);
