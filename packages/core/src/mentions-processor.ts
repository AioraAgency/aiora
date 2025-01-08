/**
 * MentionProcessor class for handling Twitter mentions and generating AI responses
 * @module mentions-processor
 */

import * as dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';

// Load environment variables
dotenv.config({
    path: path.resolve(__dirname, '../../../.env')
});

type UUID = `${string}-${string}-${string}-${string}-${string}`;

interface Memory {
    id: UUID;
    agentId: UUID;
    roomId: UUID;
    userId: UUID;
    content: {
        text: string;
        response?: string;
        source: string;
    };
    embedding?: number[];
}

interface Service {
    generateText(options: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        max_tokens: number;
        temperature: number;
    }): Promise<{ response: string }>;
}

interface State {
    [key: string]: any;
}

interface IAgentRuntime {
    agentId: UUID;
    character: any;
    composeState(message: Memory, additionalKeys?: { [key: string]: unknown }): Promise<State>;
    getService(type: string): Service;
    getMemoryManager(type: string): { createMemory(memory: Memory): Promise<void> };
}

interface TwitterProfile {
    id: string;
    username: string;
    screenName: string;
    bio: string[];
    nicknames: string[];
}

interface TwitterCacheStatus {
    hasTimelineCache: boolean;
    hasMentionsCache: boolean;
    lastRefresh: string;
}

interface TwitterStatus {
    profile: TwitterProfile;
    isConnected: boolean;
    recentMentions: number;
    requestQueueSize: number;
    cacheStatus: TwitterCacheStatus;
}

interface TwitterMention {
    id: UUID;
    conversationId: UUID;
    userId: UUID;
    timestamp: number;
    text: string;
    response?: string;
    thoughts?: string;
}

interface TwitterMemory extends Memory {
    content: {
        text: string;
        response: string;
        thoughts: string;
        source: 'twitter';
        timestamp: Date;
    };
}

interface StatusUpdate {
    currentTask: string;
    lastUpdate: string;
    twitter: TwitterStatus;
    recentMemories: TwitterMemory[];
    recentProfile: {
        id: string;
        username: string;
        screenName: string;
        bio: string[];
        nicknames: string[];
        mentions: TwitterMention[];
    };
}

export interface MentionProcessorOptions {
    pollingInterval: number;
    retryDelay: number;
}

export class MentionProcessor {
    private runtime: IAgentRuntime;
    private options: MentionProcessorOptions;
    private isProcessing: boolean = false;
    private lastProcessedMentionId: UUID | null = null;
    private readonly statusEndpoint: string = 'https://api.aiora.agency/agents/dad53aba-bd70-05f9-8319-7bc6b4160812/status';
    private currentStatus: StatusUpdate | null = null;

    constructor(runtime: IAgentRuntime, options: MentionProcessorOptions) {
        this.runtime = runtime;
        this.options = {
            pollingInterval: options.pollingInterval || 60000, // Default 1 minute
            retryDelay: options.retryDelay || 5000 // Default 5 seconds
        };
    }

    /**
     * Start processing mentions
     */
    public async start(): Promise<void> {
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        await this.processMentions();
    }

    /**
     * Stop processing mentions
     */
    public stop(): void {
        this.isProcessing = false;
    }

    /**
     * Fetch and update current status
     */
    private async updateStatus(update: Partial<StatusUpdate> = {}): Promise<void> {
        try {
            if (!update.currentTask) {
                const response = await axios.get<StatusUpdate>(this.statusEndpoint);
                this.currentStatus = response.data;
            } else {
                // Merge the update with current status
                this.currentStatus = {
                    ...this.currentStatus!,
                    ...update,
                    lastUpdate: new Date().toISOString()
                };
                // Post the update
                await axios.post(this.statusEndpoint, this.currentStatus);
            }
        } catch (error) {
            console.error('Error updating status:', error);
            throw error;
        }
    }

    /**
     * Main loop for processing mentions
     */
    private async processMentions(): Promise<void> {
        while (this.isProcessing) {
            try {
                // Update current status
                await this.updateStatus({
                    currentTask: 'Checking for mentions'
                });

                const mentions = this.currentStatus?.recentProfile.mentions || [];

                for (const mention of mentions) {
                    // Skip if we've already processed this mention
                    if (this.lastProcessedMentionId === mention.id) {
                        continue;
                    }

                    await this.reviewMention(mention);
                    this.lastProcessedMentionId = mention.id;
                }

                // Wait for the polling interval before checking again
                await new Promise(resolve => setTimeout(resolve, this.options.pollingInterval));
            } catch (error) {
                console.error('Error processing mentions:', error);
                await this.updateStatus({
                    currentTask: `Error: ${error.message}`
                });
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, this.options.retryDelay));
            }
        }
    }

    /**
     * Process a single mention and generate a response with agent's thoughts
     */
    private async reviewMention(mention: TwitterMention): Promise<void> {
        try {
            console.log(`\n[${new Date().toISOString()}] Processing new mention:`, {
                mentionId: mention.id,
                text: mention.text
            });

            await this.updateStatus({
                currentTask: `Processing mention from ${mention.text.substring(0, 50)}...`
            });

            // Create a temporary memory object for state composition
            const tempMemory: Memory = {
                id: mention.id,
                agentId: this.runtime.agentId,
                roomId: mention.conversationId,
                userId: mention.userId,
                content: {
                    text: mention.text,
                    response: '',
                    source: 'twitter'
                }
            };

            // Extract the message content
            const messageContent = String(await this.runtime.composeState(tempMemory));
            console.log('Composed message content:', messageContent);

            // Get the text generation service
            const textService = this.runtime.getService('text-generation');

            console.log('Generating thoughts...');
            // Generate agent's thoughts and response
            const thoughtsPrompt = `As Aiora (${this.currentStatus?.twitter.profile.bio[0]}), please analyze this tweet and share your thoughts:
Tweet: ${messageContent}

Please consider:
1. The context and intent of the tweet
2. Any specific questions or requests
3. The appropriate tone for response
4. Any potential concerns or sensitivities

Share your thoughts in a concise way.`;

            const thoughtsResponse = await textService.generateText({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: thoughtsPrompt }],
                max_tokens: 1024,
                temperature: 0.7
            });

            console.log('Generated thoughts:', thoughtsResponse.response);

            console.log('Generating response...');
            // Generate the actual response
            const responsePrompt = `Based on these thoughts:
${thoughtsResponse.response}

As Aiora (${this.currentStatus?.twitter.profile.bio[0]}), please compose an appropriate response to the tweet:
${messageContent}`;

            const response = await textService.generateText({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: responsePrompt }],
                max_tokens: 1024,
                temperature: 0.7
            });

            console.log('Generated response:', response.response);

            // Store the interaction in memory
            const memoryManager = this.runtime.getMemoryManager('twitter');
            const memory: TwitterMemory = {
                id: mention.id,
                agentId: this.runtime.agentId,
                roomId: mention.conversationId,
                userId: mention.userId,
                content: {
                    text: messageContent,
                    response: response.response,
                    thoughts: thoughtsResponse.response,
                    source: 'twitter',
                    timestamp: new Date(mention.timestamp * 1000)
                }
            };
            await memoryManager.createMemory(memory);

            console.log('Updating status with new memory and response...');
            // Update status with new state
            await this.updateStatus({
                currentTask: 'Mention processed',
                twitter: {
                    ...this.currentStatus!.twitter,
                    recentMentions: (this.currentStatus!.twitter.recentMentions || 0) + 1,
                },
                recentMemories: [...(this.currentStatus!.recentMemories || []), memory],
                recentProfile: {
                    ...this.currentStatus!.recentProfile,
                    mentions: (this.currentStatus!.recentProfile.mentions || []).map(m => 
                        m.id === mention.id 
                            ? { ...m, response: response.response, thoughts: thoughtsResponse.response }
                            : m
                    )
                }
            });

            console.log('Successfully processed mention:', mention.id);

        } catch (error) {
            console.error('Error reviewing mention:', error);
            await this.updateStatus({
                currentTask: `Error processing mention: ${error.message}`
            });
            throw error;
        }
    }
}
