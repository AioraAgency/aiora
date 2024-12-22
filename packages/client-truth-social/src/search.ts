import { composeContext } from "@ai16z/eliza";
import { generateMessageResponse, generateText } from "@ai16z/eliza";
import { messageCompletionFooter } from "@ai16z/eliza";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    ModelClass,
    ServiceType,
    State,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { ClientBase } from "./base";
import { buildConversationThread, sendTruth, wait } from "./utils";
import { TruthStatus, TruthUserProfile } from "./types";
import { elizaLogger } from "@ai16z/eliza";

const truthSearchTemplate = `
{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{truthUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}}. Write a {{adjective}} response that is relevant and engaging.
{{currentPost}}

IMPORTANT: Your response CANNOT be longer than 20 words.
Aim for 1-2 short sentences maximum. Be concise and direct. No emojis.
` + messageCompletionFooter;

export class TruthSearchClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private respondedPosts: Set<string> = new Set();

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    async start() {
        this.engageWithSearchTermsLoop();
    }

    private engageWithSearchTermsLoop() {
        this.engageWithSearchTerms();
        setTimeout(
            () => this.engageWithSearchTermsLoop(),
            (Math.floor(Math.random() * (120 - 60 + 1)) + 60) * 60 * 1000
        );
    }

    private async engageWithSearchTerms() {
        elizaLogger.log("Engaging with search terms");
        try {
            // Randomly select a topic from the agent's interests
            const searchTerm = [...this.runtime.character.topics][
                Math.floor(Math.random() * this.runtime.character.topics.length)
            ];

            elizaLogger.log("Searching for relevant posts");
            await wait(5000); // Rate limit protection

            // Search for posts using the topic
            const searchResults = this.client.truthApi.search({
                type: 'statuses',
                query: searchTerm,
                limit: 20
            });

            const posts: TruthStatus[] = [];
            for await (const result of searchResults) {
                posts.push(...result.statuses);
            }

            // Get recent timeline for context
            const recentPosts: TruthStatus[] = [];
            for await (const status of this.client.truthApi.getUserStatuses({
                username: this.runtime.getSetting("TRUTHSOCIAL_USERNAME"),
                limit: 50
            })) {
                recentPosts.push(status);
            }

            const formattedTimeline = `# ${this.runtime.character.name}'s Recent Posts\n\n` +
                recentPosts.map(post => 
                    `ID: ${post.id}\nContent: ${post.content}\n---\n`
                ).join("\n");

            // Randomly select a subset of posts to process
            const candidatePosts = posts
                .sort(() => Math.random() - 0.5)
                .slice(0, 20)
                .filter(post => {
                    // Filter out posts from the agent itself
                    const isOwnPost = post.account.username === this.runtime.getSetting("TRUTHSOCIAL_USERNAME");
                    // Filter out posts we've already responded to
                    const isProcessed = this.respondedPosts.has(post.id);
                    return !isOwnPost && !isProcessed;
                });

            if (candidatePosts.length === 0) {
                elizaLogger.log("No suitable posts found for interaction");
                return;
            }

            // Find the most relevant post to respond to
            const selectPostPrompt = `
Here are some posts related to "${searchTerm}":

${candidatePosts.map(post => `
ID: ${post.id}
From: ${post.account.display_name} (@${post.account.username})
Content: ${post.content}
`).join("\n")}

Which post is most relevant for ${this.runtime.character.name} to engage with? Consider:
- Relevance to the agent's interests and expertise
- Potential for meaningful interaction
- Post quality and substance
- English language content only
- Avoid posts with excessive hashtags or media
- Avoid posts that contain foul language
- Avoid posts that contain explicit content (NSFW)
Respond with only the ID of the chosen post.`;

            const selectedPostId = (await generateText({
                runtime: this.runtime,
                context: selectPostPrompt,
                modelClass: ModelClass.SMALL
            })).trim();

            const selectedPost = candidatePosts.find(p => p.id === selectedPostId);
            if (!selectedPost) {
                elizaLogger.log("No matching post found");
                return;
            }

            elizaLogger.log("Selected post for interaction:", selectedPost.content);

            // Process the selected post
            const roomId = stringToUuid(selectedPost.id + "-" + this.runtime.agentId);
            const userId = stringToUuid(selectedPost.id);

            await this.runtime.ensureConnection(
                userId,
                roomId,
                selectedPost.account.username,
                selectedPost.account.display_name,
                "truth_social"
            );

            // Build conversation context
            const thread = await buildConversationThread(selectedPost, this.client);

            // Prepare the message
            const message = {
                id: stringToUuid(selectedPost.id + "-" + this.runtime.agentId),
                content: { text: selectedPost.content },
                agentId: this.runtime.agentId,
                userId,
                roomId,
                createdAt: new Date(selectedPost.created_at).getTime()
            };

            // Generate and send response
            const state = await this.runtime.composeState(message, {
                truthUserName: this.runtime.getSetting("TRUTHSOCIAL_USERNAME"),
                timeline: formattedTimeline,
                currentPost: `From @${selectedPost.account.username}: ${selectedPost.content}`,
                recentPostInteractions: thread.map(post => 
                    `${post.account.username}: ${post.content}`
                ).join('\n')
            });

            const context = composeContext({
                state,
                template: truthSearchTemplate
            });

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            if (response.text) {
                try {
                    const callback: HandlerCallback = async (response: Content) => {
                        return sendTruth(
                            this.client,
                            response,
                            message.roomId,
                            selectedPost.id
                        );
                    };

                    const responseMessages = await callback(response);
                    const updatedState = await this.runtime.updateRecentMessageState(state);

                    for (const responseMessage of responseMessages) {
                        await this.runtime.messageManager.createMemory(responseMessage);
                    }

                    await this.runtime.processActions(message, responseMessages, updatedState);
                    this.respondedPosts.add(selectedPost.id);

                    // Cache response info for debugging
                    await this.runtime.cacheManager.set(
                        `truth_social/post_generation_${selectedPost.id}.txt`,
                        `Context:\n${context}\n\nResponse:\n${response.text}`
                    );

                    await wait();
                } catch (error) {
                    elizaLogger.error("Error sending response:", error);
                }
            }

        } catch (error) {
            elizaLogger.error("Error in search engagement:", error);
        }
    }
}