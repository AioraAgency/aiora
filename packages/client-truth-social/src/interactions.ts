import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
} from "@ai16z/eliza";
import { ClientBase } from "./base";
import { buildConversationThread, sendTruth, wait } from "./utils";
import { TruthStatus } from "./types";

export const truthShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{truthUserName}}) should respond to the message and participate in the conversation.

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT: For users not in the priority list, {{agentName}} (@{{truthUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

{{currentPost}}

Thread of Posts You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export const truthMessageHandlerTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{truthUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{truthUserName}}) while using the thread of posts as additional context:
Current Post:
{{currentPost}}

Thread of Posts You Are Replying To:
{{formattedConversation}}

Remember: Your response MUST be under 280 characters. Keep it concise and direct.
` + messageCompletionFooter;

export class TruthInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private conversationDepths: Map<string, number> = new Map();
    private maxConversationDepth: number = 5;  // Maximum replies in a thread
    private conversationTimeouts: Map<string, number> = new Map();
    private conversationTimeout: number = 30 * 60 * 1000; // 30 minutes timeout
    private recentlyProcessedPosts: Set<string> = new Set();
    private maxRecentPosts: number = 1000;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;

        // Allow configuration of limits via runtime settings
        const maxDepth = this.runtime.getSetting("MAX_CONVERSATION_DEPTH");
        if (maxDepth) this.maxConversationDepth = parseInt(maxDepth);

        const timeout = this.runtime.getSetting("CONVERSATION_TIMEOUT");
        if (timeout) this.conversationTimeout = parseInt(timeout) * 60 * 1000;
    }

    private shouldContinueConversation(threadId: string): boolean {
        const currentDepth = this.conversationDepths.get(threadId) || 0;
        const lastInteraction = this.conversationTimeouts.get(threadId) || 0;
        const timeSinceLastInteraction = Date.now() - lastInteraction;

        // Check if conversation has timed out
        if (timeSinceLastInteraction > this.conversationTimeout) {
            elizaLogger.log(`Conversation ${threadId} timed out after ${timeSinceLastInteraction/1000/60} minutes`);
            this.conversationDepths.delete(threadId);
            this.conversationTimeouts.delete(threadId);
            return true; // Allow new conversation to start
        }

        // Check if max depth reached
        if (currentDepth >= this.maxConversationDepth) {
            elizaLogger.log(`Max conversation depth (${this.maxConversationDepth}) reached for thread ${threadId}`);
            return false;
        }

        return true;
    }

    private updateConversationTracking(threadId: string) {
        const currentDepth = this.conversationDepths.get(threadId) || 0;
        this.conversationDepths.set(threadId, currentDepth + 1);
        this.conversationTimeouts.set(threadId, Date.now());
    }

    async start() {
        // Load recent post cache
        try {
            const cached = await this.runtime.cacheManager.get<string[]>(
                `truth_social/${this.runtime.getSetting("TRUTHSOCIAL_USERNAME")}/recent_posts`
            );
            if (cached) {
                this.recentlyProcessedPosts = new Set(cached);
            }
        } catch (error) {
            elizaLogger.error("Error loading recent posts cache:", error);
        }

        const handleTruthInteractionsLoop = () => {
            this.handleTruthInteractions();
            setTimeout(
                handleTruthInteractionsLoop,
                Number(this.runtime.getSetting("TRUTH_POLL_INTERVAL") || 120) * 1000
            );
        };
        handleTruthInteractionsLoop();
    }

    private shouldProcessPost(post: TruthStatus): boolean {
        // Skip if already processed
        if (this.recentlyProcessedPosts.has(post.id)) {
            return false;
        }

        // Skip if from self
        if (post.account.username === this.runtime.getSetting("TRUTHSOCIAL_USERNAME")) {
            elizaLogger.log(`Skipping own post: ${post.id}`);
            return false;
        }

        // Check recency (within last 2 hours)
        const postTime = new Date(post.created_at).getTime();
        if (Date.now() - postTime > 2 * 60 * 60 * 1000) {
            return false;
        }

        return true;
    }

    private async handlePost(post: TruthStatus): Promise<void> {
        // Double-check to ensure we don't process our own posts
        if (post.account.username === this.runtime.getSetting("TRUTHSOCIAL_USERNAME")) {
            elizaLogger.log(`Skipping own post in handlePost: ${post.id}`);
            return;
        }

        const threadId = post.in_reply_to_id || post.id;
        const roomId = stringToUuid(threadId + "-" + this.runtime.agentId);
        const userIdUUID = stringToUuid(post.account.id);

        // Check conversation limits
        if (!this.shouldContinueConversation(threadId)) {
            elizaLogger.log(`Skipping post ${post.id} due to conversation limits`);
            return;
        }

        try {
            // Save incoming post to memory first
            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                post.account.username,
                post.account.display_name,
                "truth_social"
            );

            // Check if we've already processed this post
            const postId = stringToUuid(post.id + "-" + this.runtime.agentId);
            const existingPost = await this.runtime.messageManager.getMemoryById(postId);

            if (!existingPost) {
                // Save the incoming post to memory
                const incomingMemory: Memory = {
                    id: postId,
                    content: {
                        text: post.content,
                        source: "truth_social",
                        url: post.url,
                        inReplyTo: post.in_reply_to_id ? stringToUuid(post.in_reply_to_id + "-" + this.runtime.agentId) : undefined,
                    },
                    userId: userIdUUID,
                    agentId: this.runtime.agentId,
                    roomId,
                    createdAt: new Date(post.created_at).getTime()
                };
                await this.runtime.messageManager.createMemory(incomingMemory);
            } else {
                elizaLogger.log(`Already processed post ${post.id}, skipping`);
                return;
            }

            // Build thread context
            const thread = await buildConversationThread(post, this.client);

            // Get target users for response template
            const targetUsersStr = this.runtime.getSetting("TRUTH_TARGET_USERS") || '';

            // Format post and conversation for context
            const currentPost = `From @${post.account.username}: ${post.content}`;
            const formattedConversation = thread
                .map(p => `@${p.account.username}: ${p.content}`)
                .join("\n\n");

            // Determine if we should respond
            const shouldRespondContext = composeContext({
                state: await this.runtime.composeState({
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: { text: currentPost, action: "ANALYZE" },
                    roomId: stringToUuid(threadId + "-" + this.runtime.agentId)
                }, {
                    truthUserName: this.runtime.getSetting("TRUTHSOCIAL_USERNAME"),
                    currentPost,
                    formattedConversation
                }),
                template: truthShouldRespondTemplate(targetUsersStr)
            });

            const shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL
            });

            if (shouldRespond !== "RESPOND") {
                elizaLogger.log(`Not responding to post ${post.id}: ${shouldRespond}`);
                return;
            }

            // Update tracking before generating response
            this.updateConversationTracking(threadId);

            // Generate response
            const responseContext = composeContext({
                state: await this.runtime.composeState({
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: { text: currentPost, action: "REPLY" },
                    roomId: stringToUuid(threadId + "-" + this.runtime.agentId)
                }, {
                    truthUserName: this.runtime.getSetting("TRUTHSOCIAL_USERNAME"),
                    currentPost,
                    formattedConversation
                }),
                template: truthMessageHandlerTemplate
            });

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context: responseContext,
                modelClass: ModelClass.MEDIUM
            });

            if (!response.text) {
                elizaLogger.log('No response text generated');
                return;
            }

            // Send the response
            const result = await this.client.truthApi.createStatus({
                content: response.text,
                in_reply_to_id: post.id,
                visibility: 'public'
            });

            // Save response to memory
            const responseMemory: Memory = {
                id: stringToUuid(result.id + "-" + this.runtime.agentId),
                content: {
                    text: result.content,
                    source: "truth_social",
                    url: result.url,
                    action: response.action,
                    inReplyTo: postId // Reference the saved incoming post ID
                },
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId,
                createdAt: new Date(result.created_at).getTime()
            };
            await this.runtime.messageManager.createMemory(responseMemory);

            // Update recent posts tracking
            this.recentlyProcessedPosts.add(post.id);
            if (this.recentlyProcessedPosts.size > this.maxRecentPosts) {
                const oldestPost = Array.from(this.recentlyProcessedPosts)[0];
                this.recentlyProcessedPosts.delete(oldestPost);
            }

            // Cache response context
            await this.runtime.cacheManager.set(
                `truth_social/response_${result.id}.txt`,
                `Context:\n${responseContext}\n\nResponse:\n${response.text}`
            );

            await wait();

        } catch (error) {
            elizaLogger.error(`Error handling post ${post.id}:`, error);
        }
    }

    async handleTruthInteractions() {
        elizaLogger.log("Checking Truth Social interactions");

        try {
            const username = this.runtime.getSetting("TRUTHSOCIAL_USERNAME");
            const targetUsers = (this.runtime.getSetting("TRUTH_TARGET_USERS") || '')
                .split(',')
                .map(u => u.trim())
                .filter(u => u.length > 0);

            // Process mentions
            const searchResults = this.client.truthApi.search({
                type: 'statuses',
                query: `@${username}`,
                limit: 20
            });

            for await (const result of searchResults) {
                for (const post of result.statuses) {
                    if (this.shouldProcessPost(post)) {
                        await this.handlePost(post);
                    }
                }
            }

            // Process target user posts
            for (const targetUser of targetUsers) {
                try {
                    const userPosts = this.client.truthApi.getUserStatuses({
                        username: targetUser,
                        limit: 3,
                        excludeReplies: true
                    });

                    for await (const post of userPosts) {
                        if (this.shouldProcessPost(post)) {
                            await this.handlePost(post);
                        }
                    }
                } catch (error) {
                    elizaLogger.error(`Error processing posts for ${targetUser}:`, error);
                }
            }

            // Cache processed posts
            await this.runtime.cacheManager.set(
                `truth_social/${username}/recent_posts`,
                Array.from(this.recentlyProcessedPosts)
            );

        } catch (error) {
            elizaLogger.error("Error in interaction handling:", error);
        }
    }

    private async respondToPost(post: TruthStatus, response: Content): Promise<void> {
        const roomId = stringToUuid(post.id + "-" + this.runtime.agentId);
        await sendTruth(
            this.client,
            response,
            roomId,
            post.id
        );
    }
}