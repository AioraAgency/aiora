import { IAgentRuntime, elizaLogger } from "@ai16z/eliza";
import { RedditProvider } from "../providers/redditProvider";
import { RedditPostClient } from "./redditPostClient";
import Snoowrap from "snoowrap";

export class RedditClient {
    provider: RedditProvider;
    postClient: RedditPostClient;

    constructor(runtime: IAgentRuntime) {
        const reddit = new Snoowrap({
            userAgent: 'your-user-agent',
            clientId: runtime.getSetting("REDDIT_CLIENT_ID"),
            clientSecret: runtime.getSetting("REDDIT_CLIENT_SECRET"),
            refreshToken: runtime.getSetting("REDDIT_REFRESH_TOKEN")
        });
        this.provider = new RedditProvider(runtime, reddit);
        this.postClient = new RedditPostClient(runtime, this.provider);
    }

    async start() {
        // Initialize the Reddit client
        await this.provider.start();

        // Start automatic posting if enabled
        const autoPost = this.provider.runtime.getSetting("REDDIT_AUTO_POST") === "true";
        if (autoPost) {
            await this.postClient.start();
        }
    }

    async stop() {
        await this.postClient.stop();
    }
}
