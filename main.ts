import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";

// 配置
const config = {
    PORT: 3000,
    INKEEP_CONFIG: {
        CHALLENGE_URL: 'https://api.inkeep.com/v1/challenge',
        CHAT_URL: 'https://api.inkeep.com/v1/chat/completions',
        DEFAULT_AUTH_TOKEN: Deno.env.get("DEFAULT_AUTH_TOKEN") || 'token1,token2',
        DEFAULT_REFERER: 'https://docs.anthropic.com/',
        DEFAULT_ORIGIN: 'https://docs.anthropic.com'
    },
    modelMapping: {
        'claude-3-7-sonnet-20250219': 'inkeep-context-expert'
    }
};

// 类型定义
interface TextContent {
    type: 'text';
    text: string;
}

interface ImageContent {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: string;
    };
}

type ContentPart = TextContent | ImageContent;

interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string | ContentPart[];
}

interface ChatCompletionRequest {
    messages: Message[];
    model?: string;
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
}

interface InkeepResponse {
    choices: Array<{
        message?: { content: string };
        delta?: { content?: string };
        finish_reason?: string;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

// 挑战破解类
class InkeepChallenge {
    /**
     * 使用高效的算法
     */
    static async solveChallengeOptimized(algorithm: string, challenge: string, maxnumber: number, salt: string): Promise<number> {
        const encoder = new TextEncoder();
        const batchSize = 1000;
        
        // 预计算盐值的编码
        const saltBuffer = encoder.encode(salt);
        
        for (let start = 0; start <= maxnumber; start += batchSize) {
            const end = Math.min(start + batchSize - 1, maxnumber);
            const promises = [];
            
            for (let number = start; number <= end; number++) {
                // 直接构建完整的数据缓冲区
                const numberStr = number.toString();
                const numberBuffer = encoder.encode(numberStr);
                const fullBuffer = new Uint8Array(saltBuffer.length + numberBuffer.length);
                fullBuffer.set(saltBuffer);
                fullBuffer.set(numberBuffer, saltBuffer.length);
                
                promises.push({
                    number,
                    hashPromise: crypto.subtle.digest('SHA-256', fullBuffer)
                });
            }
            
            // 等待所有哈希计算完成
            const results = await Promise.all(promises.map(p => p.hashPromise));
            
            // 检查结果
            for (let i = 0; i < results.length; i++) {
                const hashArray = Array.from(new Uint8Array(results[i]));
                const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                if (hash === challenge) {
                    return promises[i].number;
                }
            }
        }
        
        return -1;
    }

    /**
     * 解决 Inkeep 的工作量证明挑战
     */
    static async solveChallenge(): Promise<string | null> {
        try {
            const response = await fetch(config.INKEEP_CONFIG.CHALLENGE_URL, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                    'origin': config.INKEEP_CONFIG.DEFAULT_ORIGIN,
                    'referer': config.INKEEP_CONFIG.DEFAULT_REFERER,
                }
            });

            if (!response.ok) {
                throw new Error(`获取挑战失败: ${response.status} ${response.statusText}`);
            }

            const challengeData = await response.json();
            const { algorithm, challenge, maxnumber, salt } = challengeData;

            const startTime = Date.now();
            const solutionNumber = await this.solveChallengeOptimized(algorithm, challenge, maxnumber, salt);
            const endTime = Date.now();

            if (solutionNumber === -1) {
                throw new Error('破解挑战失败，未能找到正确的 number。');
            }

            const payload = { number: solutionNumber, ...challengeData };
            const jsonString = JSON.stringify(payload);
            const encoder = new TextEncoder();
            const uint8Array = encoder.encode(jsonString);
            
            let binary = '';
            uint8Array.forEach(byte => {
                binary += String.fromCharCode(byte);
            });
            
            return btoa(binary);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] 破解挑战时出错:`, error);
            return null;
        }
    }
}

// 工具类
class MessageUtils {
    /**
     * 将字符串content转换为数组格式
     */
    static normalizeContent(content: string | ContentPart[]): ContentPart[] {
        if (typeof content === 'string') {
            return [{
                type: 'text',
                text: content
            }];
        }
        return content;
    }

    /**
     * 检查content是否可以合并（只有一个text类型的元素）
     */
    static canMergeContent(content: ContentPart[]): boolean {
        return content.length === 1 && content[0].type === 'text';
    }

    /**
     * 合并两个content数组
     */
    static mergeContent(content1: ContentPart[], content2: ContentPart[]): ContentPart[] {
        const canMerge1 = this.canMergeContent(content1);
        const canMerge2 = this.canMergeContent(content2);

        // 如果两个都是单个text，则合并text内容
        if (canMerge1 && canMerge2) {
            const text1 = (content1[0] as TextContent).text;
            const text2 = (content2[0] as TextContent).text;
            return [{
                type: 'text',
                text: text1 + '\n' + text2
            }];
        }

        // 如果任何一个包含image_url或者不是单个text，则直接拼接数组
        return [...content1, ...content2];
    }

    /**
     * 将content数组转换回字符串（如果可能）
     */
    static contentToString(content: ContentPart[]): string | ContentPart[] {
        // 如果只有一个text元素，转换为字符串
        if (this.canMergeContent(content)) {
            return (content[0] as TextContent).text;
        }
        // 否则保持数组格式
        return content;
    }

    /**
     * 合并连续相同role的消息
     */
    static mergeMessages(messages: Message[]): Message[] {
        if (!messages || messages.length === 0) return [];
        
        const merged: Message[] = [];
        let current = { ...messages[0] };
        
        // 如果第一个消息是system，转换为user
        if (current.role === 'system') {
            current.role = 'user';
        }

        // 标准化第一个消息的content
        const normalizedContent = this.normalizeContent(current.content);
        current.content = normalizedContent;
        
        for (let i = 1; i < messages.length; i++) {
            let message = { ...messages[i] };
            
            // 如果当前消息是system，转换为user
            if (message.role === 'system') {
                message.role = 'user';
            }

            // 标准化消息content
            const messageContent = this.normalizeContent(message.content);
            
            // 如果role相同，尝试合并内容
            if (current.role === message.role) {
                const currentContent = Array.isArray(current.content) 
                    ? current.content 
                    : this.normalizeContent(current.content);
                
                const mergedContent = this.mergeContent(currentContent, messageContent);
                current.content = mergedContent;
            } else {
                // 在推入之前，尝试将content转换回字符串
                current.content = this.contentToString(current.content as ContentPart[]);
                merged.push(current);
                current = { ...message, content: messageContent };
            }
        }
        
        // 处理最后一个消息
        current.content = this.contentToString(current.content as ContentPart[]);
        merged.push(current);
        return merged;
    }
    
    /**
     * 转换OpenAI消息格式为Inkeep格式
     */
    static convertToInkeepFormat(messages: Message[], params: any = {}): any {
        return {
            model: params.model,
            messages: messages,
            temperature: params.temperature || 0.7,
            top_p: params.top_p || 1,
            max_tokens: params.max_tokens || 4096,
            frequency_penalty: params.frequency_penalty || 0,
            presence_penalty: params.presence_penalty || 0,
            stream: params.stream || false
        };
    }
    
    /**
     * 转换Inkeep响应为OpenAI格式
     */
    static convertFromInkeepFormat(inkeepResponse: InkeepResponse, model: string): any {
        let content = 'No response';
        
        try {
            const rawContent = inkeepResponse.choices[0]?.message?.content;
            if (rawContent) {
                // 尝试解析content中的JSON
                const parsedContent = JSON.parse(rawContent);
                content = parsedContent.content || rawContent;
            }
        } catch (error) {
            // 如果JSON解析失败，使用原始内容
            content = inkeepResponse.choices[0]?.message?.content || 'No response';
        }
        
        // 构造标准格式
        return {
            id: 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: content
                },
                finish_reason: inkeepResponse.choices[0]?.finish_reason || 'stop'
            }],
            usage: {
                prompt_tokens: inkeepResponse.usage?.prompt_tokens || 0,
                completion_tokens: inkeepResponse.usage?.completion_tokens || 0,
                total_tokens: inkeepResponse.usage?.total_tokens || 0
            }
        };
    }
}

// 响应处理器
class ResponseHandler {
    /**
     * 处理流式响应
     */
    static async handleStreamResponse(inkeepResponse: Response, model: string): Promise<Response> {
        const responseId = 'chatcmpl-' + Math.random().toString(36).substr(2, 9);
        const timestamp = Math.floor(Date.now() / 1000);
        
        const readable = new ReadableStream({
            async start(controller) {
                try {
                    if (!inkeepResponse.body) {
                        controller.close();
                        return;
                    }

                    const decoder = new TextDecoder();
                    let buffer = '';

                    // 使用异步迭代器处理流
                    for await (const chunk of inkeepResponse.body) {
                        buffer += decoder.decode(chunk, { stream: true });
                        let lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (line.trim().startsWith('data: ')) {
                                const dataContent = line.trim().substring(6);
                                
                                if (dataContent === '[DONE]') {
                                    continue;
                                }

                                try {
                                    const jsonData = JSON.parse(dataContent);
                                    const content = jsonData.choices[0]?.delta?.content;
                                    
                                    if (content) {
                                        // 转换为OpenAI格式的流式响应
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
                                        // 发送结束事件
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
                                    // 忽略无法解析的JSON行
                                }
                            }
                        }
                    }

                    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                    controller.close();
                    
                } catch (error) {
                    console.error('Stream response error:', error);
                    const errorChunk = {
                        error: {
                            message: (error as Error).message,
                            type: 'server_error'
                        }
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
                    controller.close();
                }
            }
        });

        return new Response(readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            }
        });
    }
    
    /**
     * 处理非流式响应
     */
    static async handleNonStreamResponse(inkeepResponse: Response, model: string): Promise<Response> {
        try {
            const responseData = await inkeepResponse.json();
            
            // 转换为OpenAI格式
            const openaiResponse = MessageUtils.convertFromInkeepFormat(responseData, model);
            
            return new Response(JSON.stringify(openaiResponse), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('Non-stream response error:', error);
            return new Response(JSON.stringify({ 
                error: {
                    message: 'Internal server error',
                    type: 'server_error',
                    code: 'internal_error'
                }
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
    
    /**
     * 调用Inkeep API
     */
    static async callInkeepApi(requestData: any, token: string): Promise<Response> {
        try {
            // 获取挑战解决方案
            const challengeSolution = await InkeepChallenge.solveChallenge();
            if (!challengeSolution) {
                throw new Error('无法获取挑战解决方案');
            }

            const headers = { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                'Accept': 'application/json', 
                'Content-Type': 'application/json',
                'accept-language': 'zh-CN,zh;q=0.9',
                'authorization': `Bearer ${token}`, 
                'cache-control': 'no-cache',
                'origin': config.INKEEP_CONFIG.DEFAULT_ORIGIN,
                'pragma': 'no-cache',
                'referer': config.INKEEP_CONFIG.DEFAULT_REFERER,
                'x-inkeep-challenge-solution': challengeSolution,
            };

            const response = await fetch(config.INKEEP_CONFIG.CHAT_URL, {
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
            throw new Error(`Inkeep API error: ${(error as Error).message}`);
        }
    }
}

// Token验证和选择
function getAuthToken(request: Request): string | null {
    const authHeader = request.headers.get('authorization');
    
    // 如果请求头中没有Authorization，使用默认token
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return getRandomDefaultToken();
    }
    
    const tokens = authHeader.substring(7).trim();
    
    // 检查特殊值
    if (['false', 'null', 'none'].includes(tokens.toLowerCase())) {
        return getRandomDefaultToken();
    }
    
    // 如果有多个token，随机选择一个
    if (tokens.includes(',')) {
        const tokenArray = tokens.split(',').map(t => t.trim()).filter(t => t);
        if (tokenArray.length > 0) {
            return tokenArray[Math.floor(Math.random() * tokenArray.length)];
        }
    }
    
    // 单个token情况
    return tokens || getRandomDefaultToken();
}

// 从默认token中随机选择一个
function getRandomDefaultToken(): string {
    const defaultTokens = config.INKEEP_CONFIG.DEFAULT_AUTH_TOKEN.split(',')
        .map(t => t.trim())
        .filter(t => t);
    
    if (defaultTokens.length === 0) {
        throw new Error('No default tokens configured');
    }
    
    return defaultTokens[Math.floor(Math.random() * defaultTokens.length)];
}

// 错误响应
function errorResponse(status: number, message: string, type: string = 'invalid_request_error', code: string = 'invalid_parameter'): Response {
    return new Response(JSON.stringify({
        error: {
            message,
            type,
            code
        }
    }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// 路由处理
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    // CORS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            }
        });
    }
    
    // 健康检查
    if (pathname === '/health') {
        return new Response(JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
            models: Object.keys(config.modelMapping).length,
            service: 'Inkeep API Proxy'
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    // 获取认证token
    let token: string;
    try {
        token = getAuthToken(request);
    } catch (error) {
        return errorResponse(500, 'Internal server error: No valid tokens available', 'server_error', 'internal_error');
    }
    
    // 聊天完成API
    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
        try {
            const body: ChatCompletionRequest = await request.json();
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
            } = body;
            
            // 验证必需参数
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return errorResponse(400, 'Messages array is required and cannot be empty');
            }
            
            console.log(`[${new Date().toISOString()}] Chat completion request: model=${model}, stream=${stream}, messages=${messages.length}`);
            
            // 合并连续相同role的消息
            const mergedMessages = MessageUtils.mergeMessages(messages);
            
            // 映射模型名称
            const inkeepModel = config.modelMapping[model] || 'inkeep-context-expert';
            
            // 构建请求参数
            const requestParams: any = {
                model: inkeepModel,
                stream: stream,
                ...otherParams
            };
            
            if (temperature !== undefined) requestParams.temperature = temperature;
            if (topP !== undefined) requestParams.top_p = topP;
            if (max_tokens !== undefined) requestParams.max_tokens = max_tokens;
            if (frequency_penalty !== undefined) requestParams.frequency_penalty = frequency_penalty;
            if (presence_penalty !== undefined) requestParams.presence_penalty = presence_penalty;
            
            // 转换为Inkeep API格式
            const inkeepRequest = MessageUtils.convertToInkeepFormat(mergedMessages, requestParams);
            
            console.log(`[${new Date().toISOString()}] Inkeep request prepared for model: ${inkeepModel}`);
            
            // 调用Inkeep API
            const inkeepResponse = await ResponseHandler.callInkeepApi(inkeepRequest, token);
            
            // 根据stream参数选择响应方式
            if (stream) {
                return await ResponseHandler.handleStreamResponse(inkeepResponse, model);
            } else {
                return await ResponseHandler.handleNonStreamResponse(inkeepResponse, model);
            }
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in chat completions:`, error);
            return errorResponse(500, 'Internal server error', 'server_error', 'internal_error');
        }
    }
    
    // 模型列表API
    if (pathname === '/v1/models' && request.method === 'GET') {
        try {
            const models = Object.keys(config.modelMapping).map(modelId => ({
                id: modelId,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'inkeep',
                permission: [
                    {
                        id: 'modelperm-' + Math.random().toString(36).substr(2, 9),
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
            
            return new Response(JSON.stringify({
                object: 'list',
                data: models
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('Error in models endpoint:', error);
            return errorResponse(500, 'Internal server error', 'server_error', 'internal_error');
        }
    }
    
    // 404处理
    return errorResponse(404, `Unknown request URL: ${request.method} ${pathname}`, 'invalid_request_error', 'not_found');
}

// 启动服务器
serve(handleRequest, { port: config.PORT });
