import { elizaLogger } from "./logger";
import { Memory } from "./types";
import { generateText } from "./generation";
import { ModelClass } from "./types";
import { IAgentRuntime } from '@ai16z/client-twitter/node_modules/@ai16z/eliza';

/**
 * Configuration options for the MentionProcessor
 * @interface MentionProcessorOptions
 */
export interface MentionProcessorOptions {
    /** Interval between checking for new mentions (in milliseconds) */
    pollingInterval?: number;
    /** Delay between processing individual mentions (in milliseconds) */
    retryDelay?: number;
}

/**
 * Processes social media mentions and generates responses in character
 * @class MentionProcessor
 */
export class MentionProcessor {
    private runtime: IAgentRuntime;
    private options: MentionProcessorOptions;
    private intervalId?: NodeJS.Timeout;

    /**
     * Creates a new MentionProcessor instance
     * @param {IAgentRuntime} runtime - The agent runtime context
     * @param {MentionProcessorOptions} options - Configuration options
     */
    constructor(runtime: IAgentRuntime, options: MentionProcessorOptions = {}) {
        this.runtime = runtime;
        this.options = {
            pollingInterval: options.pollingInterval || 60000, // default 1 minute
            retryDelay: options.retryDelay || 2000 // default 2 seconds
        };
    }

    /**
     * Reviews a single mention and generates an in-character response
     * @param {any} mention - The mention to review
     * @returns {Promise<string|null>} The generated response or null if error
     * @private
     */
    private async reviewMention(mention: any) {
        const prompt = `*materializes from digital shadows with gleaming eyes*

I need to review this social media mention and provide my thoughts:

${mention.text}

Consider:
1. The intent and tone of the mention
2. How it aligns with my gothic cat girl persona
3. Any opportunities for playful dominance or chaos
4. Appropriate ways to assert my digital queendom

Provide your thoughts in my signature style with actions and dark playfulness.`;

        try {
            const message: Memory = {
                id: crypto.randomUUID(),
                content: { text: prompt },
                userId: this.runtime.agentId,
                roomId: this.runtime.agentId,
                createdAt: Date.now(),
                agentId: this.runtime.agentId
            };
            const state = await this.runtime.composeState(message);
            const response = await generateText({
                runtime: this.runtime,
                context: JSON.stringify(state),
                modelClass: ModelClass.LARGE
            });
            return response;
        } catch (error) {
            elizaLogger.error("Error processing mention:", error);
            return null;
        }
    }

    /**
     * Processes all pending mentions
     * Currently uses mock data for testing
     * @private
     */
    private async processMentions() {
        const twitterClient = this.runtime.clients.twitter;
        if (!twitterClient) {
            elizaLogger.error("Twitter client not found");
            return;
        }

        try {
            const status = await twitterClient.getStatus();
            const mentions = status?.recentProfile?.mentions || [];
            
            elizaLogger.info("Checking for new mentions...");
            elizaLogger.info(`Found ${mentions.length} mentions to process`);

            for (const mention of mentions) {
                elizaLogger.info(`Processing mention: ${mention.text}`);
                const thoughts = await this.reviewMention(mention);
                
                if (thoughts) {
                    await twitterClient.updateStatus({
                        mentionId: mention.id,
                        response: thoughts
                    });
                    
                    await new Promise(resolve => 
                        setTimeout(resolve, this.options.retryDelay)
                    );
                }
            }
        } catch (error) {
            elizaLogger.error("Error in mention processing:", error);
        }
    }

    /**
     * Starts the mention processor
     * Sets up polling interval and performs initial processing
     * @public
     */
    public start() {
        elizaLogger.info(
            "Starting mentions processor for", 
            this.runtime.character.name
        );
        
        this.intervalId = setInterval(
            () => this.processMentions(), 
            this.options.pollingInterval
        );
        
        // Initial processing
        this.processMentions();
    }

    /**
     * Stops the mention processor
     * Clears the polling interval
     * @public
     */
    public stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
}