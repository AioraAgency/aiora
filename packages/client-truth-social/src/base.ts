import { TruthSocialApi } from './api';
import { TruthApiConfig, TruthStatus } from './types';
import { IAgentRuntime, elizaLogger } from '@ai16z/eliza';
import { RequestQueue } from './utils';

export class ClientBase {
    public truthApi: TruthSocialApi;
    public profile: any;
    public requestQueue: RequestQueue;
    public lastCheckedPostId: BigInt = BigInt(0);
    public runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.requestQueue = new RequestQueue();
    }

    async init() {
        const config: TruthApiConfig = {
            username: this.runtime.getSetting("TRUTHSOCIAL_USERNAME"),
            password: this.runtime.getSetting("TRUTHSOCIAL_PASSWORD")
        };

        this.truthApi = new TruthSocialApi(config);

        try {
            // If we have a token, verify it works by looking up our own profile
            if (config.username && config.password) {
                // Otherwise authenticate with username/password
                await this.truthApi.authenticate(config.username!, config.password!);
                this.profile = await this.truthApi.lookupUser(config.username!);
            }

            elizaLogger.log("Successfully initialized Truth Social client");

            // Load last checked post ID from cache
            const lastChecked = await this.runtime.cacheManager.get<{id: string}>(
                "truth_social/" + config.username + "/last_checked_post"
            );
            if (lastChecked?.id) {
                this.lastCheckedPostId = BigInt(lastChecked.id);
            }

        } catch (error) {
            elizaLogger.error("Failed to initialize Truth Social client:", error);
            throw error;
        }
    }

    async fetchSearchPosts(query: string, limit: number = 20): Promise<TruthStatus[]> {
        const posts: TruthStatus[] = [];
        
        try {
            const searchResults = this.truthApi.search({
                type: 'statuses',
                query,
                limit
            });

            for await (const result of searchResults) {
                posts.push(...result.statuses);
                if (posts.length >= limit) break;
            }
        } catch (error) {
            elizaLogger.error("Error fetching search posts:", error);
        }

        return posts.slice(0, limit);
    }

    async fetchHomeTimeline(limit: number = 50): Promise<TruthStatus[]> {
        const username = this.runtime.getSetting("TRUTHSOCIAL_USERNAME");
        const posts: TruthStatus[] = [];

        try {
            const timeline = this.truthApi.getUserStatuses({
                username,
                limit
            });

            for await (const post of timeline) {
                posts.push(post);
                if (posts.length >= limit) break;
            }
        } catch (error) {
            elizaLogger.error("Error fetching home timeline:", error);
        }

        return posts;
    }

    async fetchTimelineForActions(limit: number = 15): Promise<TruthStatus[]> {
        const posts: TruthStatus[] = [];
        
        try {
            // Get trending posts
            const trending = await this.truthApi.trending(Math.floor(limit / 3));
            posts.push(...trending);

            // Get latest posts from followed users
            const home = await this.fetchHomeTimeline(Math.floor(limit / 3));
            posts.push(...home);

            // Get posts from followed hashtags/topics
            for (const topic of this.runtime.character.topics) {
                const topicPosts = await this.fetchSearchPosts(topic, Math.floor(limit / 3));
                posts.push(...topicPosts);
            }
        } catch (error) {
            elizaLogger.error("Error fetching timeline for actions:", error);
        }

        // Deduplicate by ID and sort by timestamp
        const uniquePosts = Array.from(
            new Map(posts.map(post => [post.id, post])).values()
        ).sort((a, b) => 
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        return uniquePosts.slice(0, limit);
    }

    async saveRequestMessage(message: any, state: any) {
        await this.runtime.messageManager.createMemory(message, false);
        await this.runtime.updateRecentMessageState(state);
    }

    async cachePost(post: TruthStatus) {
        await this.runtime.cacheManager.set(
            `truth_social/${this.profile.username}/post/${post.id}`,
            post
        );
    }

    async cacheLatestCheckedPostId() {
        if (this.lastCheckedPostId) {
            await this.runtime.cacheManager.set(
                `truth_social/${this.profile.username}/last_checked_post`,
                { id: this.lastCheckedPostId.toString() }
            );
        }
    }

    async cacheTimeline(timeline: TruthStatus[]) {
        await this.runtime.cacheManager.set(
            `truth_social/${this.profile.username}/timeline`,
            timeline
        );
    }
}