import { IAgentRuntime, elizaLogger, generateText, ModelClass, composeContext } from "@ai16z/eliza";
import { RedditProvider } from "../providers/redditProvider";

const redditPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a Reddit post in the voice and style of {{agentName}}.
Write a post for r/{{subreddit}} that is {{adjective}} about {{topic}}.
Title should be brief and engaging.
Content should be 2-4 sentences, natural and conversational.

Format your response as:
Title: <your title>
Content: <your content>`;

export class RedditPostClient {
    runtime: IAgentRuntime;
    reddit: RedditProvider;
    private stopProcessing: boolean = false;

    constructor(runtime: IAgentRuntime, reddit: RedditProvider) {
        this.runtime = runtime;
        this.reddit = reddit;
    }

    async start(postImmediately: boolean = false) {
        if (postImmediately) {
            await this.generateNewPost();
        }

        this.startPostingLoop();
    }

    private async startPostingLoop() {
        while (!this.stopProcessing) {
            try {
                const lastPost = await this.runtime.cacheManager.get<{
                    timestamp: number;
                }>("reddit/lastPost");

                const lastPostTimestamp = lastPost?.timestamp ?? 0;
                const minMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
                const maxMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
                const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
                const delay = randomMinutes * 60 * 1000;

                if (Date.now() > lastPostTimestamp + delay) {
                    await this.generateNewPost();
                }

                elizaLogger.log(`Next Reddit post scheduled in ${randomMinutes} minutes`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } catch (error) {
                elizaLogger.error("Error in Reddit posting loop:", error);
                await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000)); // Wait 5 minutes on error
            }
        }
    }

    private async generateNewPost() {
        elizaLogger.log("Generating new Reddit post");

        try {
            // Pick a random subreddit from configuration
            const subreddits = (this.runtime.getSetting("REDDIT_SUBREDDITS") || "test").split(",");
            const subreddit = subreddits[Math.floor(Math.random() * subreddits.length)].trim();

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    content: { text: "", action: "POST" }
                },
                { subreddit }
            );

            const context = composeContext({
                state,
                template: redditPostTemplate
            });

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.MEDIUM
            });

            // Parse the response
            const titleMatch = response.match(/Title:\s*(.*)/i);
            const contentMatch = response.match(/Content:\s*(.*)/is);

            if (!titleMatch || !contentMatch) {
                elizaLogger.error("Failed to parse post content from response:", response);
                return;
            }

            const title = titleMatch[1].trim();
            const content = contentMatch[1].trim();

            if (this.runtime.getSetting("REDDIT_DRY_RUN") === "true") {
                elizaLogger.info(`[DRY RUN] Would post to r/${subreddit}:\nTitle: ${title}\nContent: ${content}`);
                return;
            }

            const post = await this.reddit.submitSelfpost({
                subredditName: subreddit,
                title,
                text: content
            });

            await this.runtime.cacheManager.set("reddit/lastPost", {
                id: post.id,
                timestamp: Date.now()
            });

            elizaLogger.log(`Posted to Reddit: ${post.url}`);

        } catch (error) {
            elizaLogger.error("Error generating Reddit post:", error);
        }
    }

    async stop() {
        this.stopProcessing = true;
    }
}
