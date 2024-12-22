import { Content, Memory, UUID } from "@ai16z/eliza";
import { getEmbeddingZeroVector } from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { elizaLogger } from "@ai16z/eliza";
import { ClientBase } from "./base";
import { TruthStatus } from "./types";

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export async function buildConversationThread(
    post: TruthStatus,
    client: ClientBase,
    maxDepth: number = 10
): Promise<TruthStatus[]> {
    const thread: TruthStatus[] = [];
    const visited = new Set<string>();

    async function processThread(currentPost: TruthStatus, depth: number = 0) {
        if (!currentPost || depth >= maxDepth || visited.has(currentPost.id)) {
            return;
        }

        visited.add(currentPost.id);
        thread.unshift(currentPost);

        // Save to memory
        const memory = await client.runtime.messageManager.getMemoryById(
            stringToUuid(currentPost.id + "-" + client.runtime.agentId)
        );

        if (!memory) {
            const roomId = stringToUuid(currentPost.id + "-" + client.runtime.agentId);
            const userId = stringToUuid(currentPost.id);

            await client.runtime.ensureConnection(
                userId,
                roomId,
                currentPost.account.username,
                currentPost.account.display_name,
                "truth_social"
            );

            await client.runtime.messageManager.createMemory({
                id: stringToUuid(currentPost.id + "-" + client.runtime.agentId),
                agentId: client.runtime.agentId,
                content: {
                    text: currentPost.content,
                    source: "truth_social",
                    url: currentPost.url,
                    inReplyTo: currentPost.in_reply_to_id
                        ? stringToUuid(currentPost.in_reply_to_id + "-" + client.runtime.agentId)
                        : undefined
                },
                createdAt: new Date(currentPost.created_at).getTime(),
                roomId,
                userId,
                embedding: getEmbeddingZeroVector()
            });
        }

        if (currentPost.in_reply_to_id) {
            try {
                const comments = client.truthApi.getUserStatuses({
                    username: currentPost.account.username,
                    limit: 1,
                    sinceId: currentPost.in_reply_to_id
                });

                for await (const comment of comments) {
                    await processThread(comment, depth + 1);
                }
            } catch (error) {
                elizaLogger.error("Error fetching parent post:", error);
            }
        }
    }

    await processThread(post);
    return thread;
}

export async function sendTruth(
    client: ClientBase,
    response: Content,
    roomId: UUID,
    replyToId?: string
): Promise<Memory[]> {
    const memories: Memory[] = [];
    const text = response.text?.trim();

    if (!text) return memories;

    try {
        const result = await client.truthApi.createStatus({
            content: text,
            in_reply_to_id: replyToId,
            visibility: 'public'
        });

        const memory: Memory = {
            id: stringToUuid(result.id + "-" + client.runtime.agentId),
            userId: client.runtime.agentId,
            agentId: client.runtime.agentId,
            content: {
                text: result.content,
                url: result.url,
                source: "truth_social",
                action: response.action,
                inReplyTo: replyToId ? stringToUuid(replyToId + "-" + client.runtime.agentId) : undefined
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: new Date(result.created_at).getTime()
        };

        memories.push(memory);
        await client.cachePost(result);

    } catch (error) {
        elizaLogger.error("Error sending truth:", error);
        throw error;
    }

    return memories;
}

export class RequestQueue {
    private queue: (() => Promise<any>)[] = [];
    private processing = false;

    async add<T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.process();
        });
    }

    private async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            if (task) await task();
        }

        this.processing = false;
    }
}