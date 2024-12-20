import { Provider, IAgentRuntime } from "@ai16z/eliza";
import Snoowrap from "snoowrap";
import { RedditPostClient } from "../clients/redditPostClient";

export class RedditProvider {
    postClient: RedditPostClient;
    runtime: IAgentRuntime;
    reddit: Snoowrap;

    constructor(runtime: IAgentRuntime, reddit: Snoowrap) {
        this.runtime = runtime;
        this.reddit = reddit;
        this.postClient = new RedditPostClient(runtime, this);
    }

    async start() {
        const postImmediately = this.runtime.getSetting("POST_IMMEDIATELY") === "true";
        await this.postClient.start(postImmediately);
    }

    async submitSelfpost({ subredditName, title, text }: {
        subredditName: string;
        title: string;
        text: string;
    }) {
        return await this.reddit.getSubreddit(subredditName).submitSelfpost({
            title,
            text
        });
    }
}

export const redditProvider: Provider = {
    provide: async (runtime: IAgentRuntime) => {
        const reddit = new Snoowrap({
            userAgent: 'your-user-agent',
            clientId: runtime.getSetting("REDDIT_CLIENT_ID"),
            clientSecret: runtime.getSetting("REDDIT_CLIENT_SECRET"),
            refreshToken: runtime.getSetting("REDDIT_REFRESH_TOKEN")
        });

        const provider = new RedditProvider(runtime, reddit);
        await provider.start();
        return { reddit: provider };
    }
};

