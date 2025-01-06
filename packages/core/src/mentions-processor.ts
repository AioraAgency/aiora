import { AgentRuntime } from "./runtime";
import { elizaLogger } from "./logger";

export interface MentionProcessorOptions {
    pollingInterval?: number; // in milliseconds
    retryDelay?: number;     // delay between mention processing
}

export class MentionProcessor {
    private runtime: AgentRuntime;
    private options: MentionProcessorOptions;
    private intervalId?: NodeJS.Timeout;

    constructor(runtime: AgentRuntime, options: MentionProcessorOptions = {}) {
        this.runtime = runtime;
        this.options = {
            pollingInterval: options.pollingInterval || 60000, // default 1 minute
            retryDelay: options.retryDelay || 2000 // default 2 seconds
        };
    }

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
            const response = await this.runtime.think(prompt);
            return response;
        } catch (error) {
            elizaLogger.error("Error processing mention:", error);
            return null;
        }
    }

    private async processMentions() {
        const twitterClient = this.runtime.clients.twitter;
        if (!twitterClient) {
            elizaLogger.error("Twitter client not found");
            return;
        }

        try {
            const status = await twitterClient.getStatus();
            const mentions = status?.recentProfile?.mentions || [];

            for (const mention of mentions) {
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

    public stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
}