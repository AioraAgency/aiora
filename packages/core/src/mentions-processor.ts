import { AgentRuntime } from "./runtime";
import { elizaLogger } from "./logger";
import { Memory } from "./types";
import { generateText } from "./generation";
import { ModelClass } from "./types";

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

    private async processMentions() {
        try {
            // Mock data for testing
            const mockMentions = [{
                id: '123',
                text: '@aiora Hey there! Testing the mention processor'
            }];
            
            elizaLogger.info("Checking for new mentions...");
            elizaLogger.info(`Found ${mockMentions.length} mentions to process`);

            for (const mention of mockMentions) {
                elizaLogger.info(`Processing mention: ${mention.text}`);
                const thoughts = await this.reviewMention(mention);
                
                if (thoughts) {
                    elizaLogger.info(`Responding to mention with: ${thoughts}`);
                    // Log instead of making API call
                    elizaLogger.info(`Would have posted response to Twitter: ${thoughts}`);
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